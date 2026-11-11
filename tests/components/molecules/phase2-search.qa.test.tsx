// QA (QA-W3-molecules-C): T64 SearchBox, DepartmentMenu.
// Criteria: BACKLOG-phase2.md "### T64", SR2/SR3/SR6, input-limit table (search query 100),
// suggest route contract src/app/api/search/suggest/_lib/suggest.ts (T53).
import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Category } from "@/lib/types";
import { isAllowedInternalHref } from "@/content/routes";
import {
  MAX_QUERY_LENGTH,
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_KEY,
  SUGGEST_DEBOUNCE_MS,
  SearchBox,
  isSafeSuggestionHref,
  parseSuggestBody,
  pushRecentSearch,
  readRecentSearches,
  shouldFetchSuggestions,
} from "@/components/molecules/SearchBox";
import { DepartmentMenu, buildMenuModel, type DepartmentInput } from "@/components/molecules/DepartmentMenu";
import { expectFocused } from "@/test/dom-assertions";

// ---------------------------------------------------------------- helpers

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;
const RTL = "\u202Eمرحبا שלום";
const LONG_WORD = "W".repeat(10_000);
const DEPTS = [
  { slug: "electronics", name: "Electronics" },
  { slug: "home-kitchen", name: "Home & Kitchen" },
];

type FetchFn = typeof fetch;
const realFetch = globalThis.fetch;
interface FetchCall {
  url: string;
  init?: RequestInit;
}
function setFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = mock((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  globalThis.fetch = fn as unknown as FetchFn;
  return calls;
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const combo = () => screen.getByRole("combobox", { name: "Search products" }) as HTMLInputElement;
const listbox = () => screen.getByRole("listbox", { hidden: true });
const opts = () => within(listbox()).queryAllByRole("option", { hidden: true });
function typeQ(value: string) {
  fireEvent.focus(combo());
  fireEvent.change(combo(), { target: { value } });
}
async function settle(ms = SUGGEST_DEBOUNCE_MS + 60) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
function stripReplay(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (s) => (s.includes("$$reactFormReplay") || s.includes("requestFormReset") ? "" : s));
}
const SUGGEST_BODY = {
  suggestions: [
    { type: "product", label: "Oak Desk", href: "/products/oak-desk" },
    { type: "category", label: "Desks", href: "/category/desks" },
    { type: "brand", label: "Acme", href: "/brand/acme" },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  window.localStorage.clear();
  document.body.style.overflow = "";
});

const ROOT = join(import.meta.dir, "../../../src/components/molecules");
const FILES = [
  "SearchBox/SearchBox.tsx",
  "SearchBox/search-helpers.ts",
  "DepartmentMenu/DepartmentMenu.tsx",
  "DepartmentMenu/menu-model.ts",
];

describe("T64 source gates", () => {
  for (const file of FILES) {
    test(`${file}: no any / ts-ignore / eslint-disable / dangerouslySetInnerHTML / style= / runtime server import`, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).not.toMatch(/:\s*any\b|<any>|as any\b|any\[\]/);
      expect(src).not.toMatch(/@ts-(ignore|expect-error|nocheck)/);
      expect(src).not.toContain("eslint-disable");
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/\bstyle=/);
      for (const line of src.split("\n").filter((l) => /from ["']@\/server\//.test(l))) expect(line).toMatch(/^import type /);
    });
  }
});

// ---------------------------------------------------------------- SearchBox: no JS

describe("T64 AC1 SearchBox without JS", () => {
  test("GET form to /search (role=search), q input, dept select joined via form=, no nested forms, no combobox ARIA, no script", () => {
    const html = stripReplay(renderToStaticMarkup(<SearchBox departments={DEPTS} defaultDept="electronics" defaultQuery="desk" />));
    expect(html).not.toContain("<script");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const forms = doc.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    const form = forms[0]!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/search");
    expect(form.getAttribute("role")).toBe("search");
    const q = form.querySelector('input[name="q"]')!;
    expect(q.getAttribute("value")).toBe("desk");
    const select = doc.querySelector('select[name="dept"]')!;
    expect(select.closest("form")).toBeNull();
    expect(select.getAttribute("form")).toBe(form.id);
    expect(form.id).not.toBe("");
    expect(select.querySelector("option[selected]")!.getAttribute("value")).toBe("electronics");
    expect(select.getAttribute("aria-label")).toBe("Search in department");
    expect(form.querySelector('button[type="submit"]')).not.toBeNull();
    expect(html).not.toMatch(/role="combobox"|aria-expanded|role="listbox"/);
  });

  test("department options: 'All departments' ('') first; blank slug/name dropped; unknown defaultDept -> All", () => {
    const html = renderToStaticMarkup(
      <SearchBox departments={[...DEPTS, { slug: "", name: "Blank" }, { slug: "x", name: "" }, { slug: "evil", name: HOSTILE }]} defaultDept="nope" />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const options = Array.from(doc.querySelectorAll('select[name="dept"] option'));
    expect(options.map((o) => o.getAttribute("value"))).toEqual(["", "electronics", "home-kitchen", "evil"]);
    expect(options[0]!.hasAttribute("selected")).toBe(true);
    expect(options[3]!.textContent).toBe(HOSTILE);
    expect(doc.querySelector("img, script")).toBeNull();
  });
});

// ---------------------------------------------------------------- AC6 maxLength

describe("T64 AC6 query cut by maxLength (100, input-limit table)", () => {
  test("hydrated: the input has maxLength=100", () => {
    render(<SearchBox departments={DEPTS} />);
    expect(combo().maxLength).toBe(MAX_QUERY_LENGTH);
  });

  // DEFECT D-T64-1: the server HTML (what a no-JS visitor gets) has no maxlength, so a
  // >100-char query is not cut; SearchField now forwards `maxLength` (ATOMS-4 landed:
  // "present in the no-JS server HTML too") but SearchBox still sets it on the node after hydration.
  test("DEFECT D-T64-1: server markup carries maxlength=\"100\" on the q input", () => {
    const html = renderToStaticMarkup(<SearchBox departments={DEPTS} />);
    // React SSR emits `maxLength="100"`; HTML attribute names are case-insensitive.
    expect(html).toMatch(/<input[^>]*name="q"[^>]*maxlength="100"|<input[^>]*maxlength="100"[^>]*name="q"/i);
  });
  test("evidence D-T64-1 (fixed): maxlength in SSR; SearchField supports the prop; SearchBox passes it", () => {
    const html = renderToStaticMarkup(<SearchBox departments={DEPTS} />);
    expect(html.toLowerCase()).toContain('maxlength="100"');
    const atom = readFileSync(join(import.meta.dir, "../../../src/components/atoms/SearchField/SearchField.tsx"), "utf8");
    expect(atom).toContain("maxLength?: number;");
    const box = readFileSync(join(ROOT, "SearchBox/SearchBox.tsx"), "utf8");
    expect(box).not.toContain("node.maxLength = MAX_QUERY_LENGTH");
    expect(box).toMatch(/maxLength=\{MAX_QUERY_LENGTH\}/);
  });

  test("observation: a >100-char defaultQuery is shown and posted uncut (maxLength does not trim existing values)", () => {
    render(<SearchBox departments={DEPTS} defaultQuery={"q".repeat(150)} />);
    expect(combo().value).toHaveLength(150);
  });
});

// ---------------------------------------------------------------- AC2 combobox + suggest contract

describe("T64 AC2 combobox, suggest route contract, debounce, abort", () => {
  test("debounce (fake timers): 3 edits within 250 ms -> exactly 1 fetch of `/api/search/suggest?q=<last>` with same-origin creds", () => {
    const calls = setFetch(() => new Promise<Response>(() => {}));
    jest.useFakeTimers();
    try {
      render(<SearchBox departments={DEPTS} />);
      typeQ("la");
      act(() => void jest.advanceTimersByTime(100));
      typeQ("lam");
      act(() => void jest.advanceTimersByTime(100));
      typeQ("lamp shade");
      act(() => void jest.advanceTimersByTime(SUGGEST_DEBOUNCE_MS - 1));
      expect(calls).toHaveLength(0);
      act(() => void jest.advanceTimersByTime(1));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("/api/search/suggest?q=lamp%20shade");
      expect(calls[0]!.init?.credentials).toBe("same-origin");
      expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      jest.useRealTimers();
    }
  });

  test("queries under 2 or over 100 code points (trimmed) never hit the route", async () => {
    const calls = setFetch(async () => json(200, SUGGEST_BODY));
    render(<SearchBox departments={DEPTS} />);
    for (const q of ["a", "  b  ", "x".repeat(101), "😀"]) {
      typeQ(q);
      await settle();
    }
    expect(calls).toHaveLength(0);
    expect(shouldFetchSuggestions("x".repeat(100))).toBe(true);
    expect(shouldFetchSuggestions("😀".repeat(100))).toBe(true);
  });

  test("a newer query aborts the stale request; unmount aborts the in-flight request", async () => {
    const calls = setFetch(() => new Promise<Response>(() => {}));
    const { unmount } = render(<SearchBox departments={DEPTS} />);
    typeQ("desk");
    await settle();
    typeQ("desks");
    expect((calls[0]!.init!.signal as AbortSignal).aborted).toBe(true);
    await settle();
    expect(calls).toHaveLength(2);
    unmount();
    expect((calls[1]!.init!.signal as AbortSignal).aborted).toBe(true);
  });

  test("results: listbox of role=option text labels, aria-expanded=true, aria-controls, count announced", async () => {
    setFetch(async () => json(200, SUGGEST_BODY));
    render(<SearchBox departments={DEPTS} />);
    typeQ("des");
    await settle();
    expect(combo()).toHaveAttribute("aria-expanded", "true");
    expect(combo().getAttribute("aria-controls")).toBe(listbox().id);
    expect(opts().map((o) => o.textContent)).toEqual(["Oak Desk", "Desks", "Acme"]);
    expect(screen.getByRole("status")).toHaveTextContent("3 suggestions available");
  });

  test("keyboard: Down/Up move aria-activedescendant (wraps), Enter navigates to the option href, Escape closes", async () => {
    setFetch(async () => json(200, SUGGEST_BODY));
    const nav: string[] = [];
    render(<SearchBox departments={DEPTS} onNavigate={(h) => nav.push(h)} />);
    typeQ("des");
    await settle();
    fireEvent.keyDown(combo(), { key: "ArrowDown" });
    const o = opts();
    expect(combo().getAttribute("aria-activedescendant")).toBe(o[0]!.id);
    expect(o[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(combo(), { key: "ArrowUp" });
    expect(combo().getAttribute("aria-activedescendant")).toBe(o[2]!.id); // wrapped to last
    fireEvent.keyDown(combo(), { key: "ArrowDown" });
    fireEvent.keyDown(combo(), { key: "ArrowDown" });
    expect(combo().getAttribute("aria-activedescendant")).toBe(o[1]!.id);
    fireEvent.keyDown(combo(), { key: "Enter" });
    expect(nav).toEqual(["/category/desks"]);
    // Escape after re-opening closes the list.
    typeQ("desk");
    await settle();
    expect(combo()).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(combo(), { key: "Escape" });
    expect(combo()).toHaveAttribute("aria-expanded", "false");
    expect(combo().hasAttribute("aria-activedescendant")).toBe(false);
  });

  for (const [label, impl] of [
    ["HTTP 500", async () => json(500, { error: "internal" })],
    ["HTTP 429", async () => json(429, { error: "rate_limited", retryAfterSeconds: 30 })],
    ["HTTP 400 query_too_long", async () => json(400, { error: "query_too_long" })],
    ["network error", async () => Promise.reject(new TypeError("Failed to fetch"))],
    ["invalid JSON", async () => new Response("<html>", { status: 200 })],
    ["wrong shape", async () => json(200, { suggestions: "nope" })],
  ] as const) {
    test(`fetch failure (${label}) silently hides the list: no alert, no throw, form still usable`, async () => {
      setFetch(impl as (u: string) => Promise<Response>);
      const { container } = render(<SearchBox departments={DEPTS} />);
      typeQ("desk");
      await settle();
      expect(combo()).toHaveAttribute("aria-expanded", "false");
      expect(opts()).toHaveLength(0);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(combo().value).toBe("desk");
    });
  }

  // Brief check (not a backlog AC): control characters should be rejected before the network.
  // The route answers them (T53 D2) but the client still spends a rate-limited request.
  test("DEFECT D-T64-2: queries containing control characters are not sent to the suggest route", async () => {
    const calls = setFetch(async () => json(200, SUGGEST_BODY));
    render(<SearchBox departments={DEPTS} />);
    typeQ("de\u0007sk");
    await settle();
    typeQ("de\u0000sk");
    await settle();
    expect(calls).toHaveLength(0);
  });
  test("evidence D-T64-2 (fixed): shouldFetchSuggestions rejects control characters", () => {
    expect(shouldFetchSuggestions("de\u0007sk")).toBe(false);
    expect(shouldFetchSuggestions("a\u0000b")).toBe(false);
    expect(shouldFetchSuggestions("desk")).toBe(true);
  });

  test("zero-width / RTL queries are URL-encoded (no raw chars in the request URL)", () => {
    const calls = setFetch(() => new Promise<Response>(() => {}));
    jest.useFakeTimers();
    try {
      render(<SearchBox departments={DEPTS} />);
      typeQ(`de\u200Bsk ${RTL} &x=1#h`);
      act(() => void jest.advanceTimersByTime(SUGGEST_DEBOUNCE_MS));
      expect(calls).toHaveLength(1);
      const url = calls[0]!.url;
      expect(url.startsWith("/api/search/suggest?q=")).toBe(true);
      expect(url).not.toMatch(/[\u200B\u202E&#\s]/);
      expect(new URL(url, "https://x.test").searchParams.get("q")).toBe(`de\u200Bsk ${RTL} &x=1#h`);
      expect([...new URL(url, "https://x.test").searchParams.keys()]).toEqual(["q"]);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------- AC3 text + hrefs

describe("T64 AC3 suggestions are plain text; hrefs start with '/'", () => {
  test("hostile / RTL / 10k labels are text; unsafe hrefs dropped (javascript:, https:, //, /\\, control chars, empty)", async () => {
    setFetch(async () =>
      json(200, {
        suggestions: [
          { type: "product", label: HOSTILE, href: "/products/a" },
          { type: "product", label: RTL, href: "/products/b" },
          { type: "product", label: LONG_WORD, href: "/products/c" },
          { type: "product", label: "JS", href: "javascript:alert(1)" },
          { type: "product", label: "Abs", href: "https://evil.example/x" },
          { type: "product", label: "Proto", href: "//evil.example" },
          { type: "product", label: "Back", href: "/\\evil.example" },
          { type: "product", label: "Ctl", href: "/products/x\u0000" },
          { type: "product", label: "Empty", href: "" },
          { type: "product", label: "   ", href: "/products/blank" },
        ],
      }),
    );
    const nav: string[] = [];
    const { container } = render(<SearchBox departments={DEPTS} onNavigate={(h) => nav.push(h)} />);
    typeQ("xx");
    await settle();
    expect(opts().map((o) => o.textContent)).toEqual([HOSTILE, RTL, LONG_WORD]);
    expect(container.querySelector("img, script")).toBeNull();
    expect(listbox().querySelectorAll("a")).toHaveLength(0);
    for (const o of opts()) {
      fireEvent.click(o);
    }
    expect(nav.every((h) => h.startsWith("/") && !h.startsWith("//"))).toBe(true);
  });

  test("route-shaped hrefs (product/category/brand/search) pass isAllowedInternalHref", () => {
    const items = parseSuggestBody(SUGGEST_BODY);
    for (const i of items) expect(isAllowedInternalHref(i.href)).toBe(true);
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(["oak desk", "a&b"]));
  });

  test("observation: client href check is 'starts with /' (AC3), not the route allow-list", () => {
    expect(isSafeSuggestionHref("/not-a-route")).toBe(true);
    expect(isAllowedInternalHref("/not-a-route")).toBe(false);
  });

  test("selecting a suggestion never uses an href that failed validation (defence in depth in handleSelect)", () => {
    expect(isSafeSuggestionHref("javascript:alert(1)")).toBe(false);
    expect(isSafeSuggestionHref("/\\evil")).toBe(false);
    expect(isSafeSuggestionHref("//evil")).toBe(false);
    expect(isSafeSuggestionHref(`/${"a".repeat(2048)}`)).toBe(false);
  });
});

// ---------------------------------------------------------------- AC4 recents / storage

describe("T64 AC4 localStorage resilience, cap 5, de-dupe, Clear recent", () => {
  function brokenStorage(mode: "getter" | "methods") {
    const desc = Object.getOwnPropertyDescriptor(window, "localStorage");
    if (mode === "getter") {
      Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new DOMException("denied", "SecurityError"); } });
    } else {
      const thrower = () => {
        throw new DOMException("quota", "QuotaExceededError");
      };
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: { getItem: thrower, setItem: thrower, removeItem: thrower, clear: () => {}, key: () => null, length: 0 },
      });
    }
    return () => {
      if (desc) Object.defineProperty(window, "localStorage", desc);
    };
  }

  for (const mode of ["getter", "methods"] as const) {
    test(`localStorage ${mode} throwing: renders, focuses, submits, selects without throwing`, async () => {
      setFetch(async () => json(200, SUGGEST_BODY));
      const restore = brokenStorage(mode);
      try {
        const nav: string[] = [];
        const { container } = render(<SearchBox departments={DEPTS} popularSearches={["lamps"]} onNavigate={(h) => nav.push(h)} />);
        fireEvent.focus(combo());
        typeQ("desk");
        await settle();
        fireEvent.keyDown(combo(), { key: "ArrowDown" });
        fireEvent.keyDown(combo(), { key: "Enter" });
        expect(nav).toEqual(["/products/oak-desk"]);
        const form = container.querySelector("form")!;
        form.addEventListener("submit", (e) => e.preventDefault());
        fireEvent.submit(form);
      } finally {
        restore();
      }
    });
  }

  test("pushRecentSearch: cap 5, newest first, case-insensitive de-dupe, trims, ignores blank/control chars", () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    for (const q of ["one", "two", "three", "four", "five", "six", " TWO ", "", "   ", "bad\u0007"]) pushRecentSearch(s, q);
    expect(readRecentSearches(s)).toEqual(["TWO", "six", "five", "four", "three"]);
    expect(readRecentSearches(s)).toHaveLength(MAX_RECENT_SEARCHES);
  });

  test("tampered storage (non-array, objects, 10k strings, > 5 entries, hostile) is sanitised", () => {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify([HOSTILE, 5, { a: 1 }, LONG_WORD, "a", "b", "c", "d", "e"]));
    render(<SearchBox departments={DEPTS} />);
    fireEvent.focus(combo());
    const labels = opts().map((o) => o.textContent ?? "");
    expect(labels).toHaveLength(5);
    expect(labels[0]).toBe(`Recent: ${HOSTILE}`);
    expect(labels[1]!.length).toBe("Recent: ".length + MAX_QUERY_LENGTH);
    expect(document.querySelector("img, script")).toBeNull();
    window.localStorage.setItem(RECENT_SEARCHES_KEY, "{not json");
    expect(readRecentSearches(window.localStorage)).toEqual([]);
  });

  test("submit records the query; 'Clear recent searches' exists, is a 44px button, and clears storage + list", () => {
    const { container } = render(<SearchBox departments={DEPTS} popularSearches={["lamps"]} />);
    const form = container.querySelector("form")!;
    form.addEventListener("submit", (e) => e.preventDefault());
    typeQ("oak desk");
    fireEvent.submit(form);
    expect(JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY)!)).toEqual(["oak desk"]);
    fireEvent.change(combo(), { target: { value: "" } });
    fireEvent.focus(combo());
    expect(opts().map((o) => o.textContent)).toEqual(["Recent: oak desk", "lamps"]);
    const clear = screen.getByRole("button", { name: /Clear recent searches/ });
    expect(clear.className).toMatch(/min-h-touch/);
    fireEvent.click(clear);
    expect(window.localStorage.getItem(RECENT_SEARCHES_KEY)).toBeNull();
    expect(opts().map((o) => o.textContent)).toEqual(["lamps"]);
  });
});

// ---------------------------------------------------------------- SR6 SearchBox

describe("T64 SR6 SearchBox touch targets and labels", () => {
  test("select, input and submit carry 44px classes; input labelled; submit named", () => {
    const { container } = render(<SearchBox departments={DEPTS} />);
    expect(container.querySelector("select")!.className).toMatch(/min-h-touch/);
    expect(combo().className).toMatch(/min-h-touch|min-h-12/);
    const submit = screen.getByRole("button", { name: "Submit search" });
    expect(submit.className).toMatch(/min-h-touch/);
    expect(screen.getByLabelText("Search in department")).toBe(container.querySelector("select")!);
  });
});

// ---------------------------------------------------------------- DepartmentMenu

function cat(id: string, slug: string, name: string, parentId: string | null, sortOrder = 0): Category {
  return { id, slug, name, description: "", parentId, sortOrder, imageUrl: null };
}
const DEPARTMENTS: DepartmentInput[] = [
  {
    ...cat("d1", "electronics", "Electronics", null, 1),
    children: [Object.assign(cat("c1", "laptops", "Laptops", "d1"), { children: [cat("g1", "deep", "Too deep", "c1")] }), cat("c2", "audio", "Audio", "d1", 2)],
  },
  { ...cat("d2", "home", "Home", null, 2), children: [] },
];
const trigger = () => screen.getByRole("button", { name: "Open menu, All" });
const dialog = () => document.querySelector("dialog") as HTMLDialogElement;

describe("T64 AC5 DepartmentMenu", () => {
  test("no-JS markup: a plain link to /products (no button, no dialog, no script), 44px", () => {
    const html = stripReplay(renderToStaticMarkup(<DepartmentMenu departments={DEPARTMENTS} />));
    expect(html).not.toMatch(/<(button|dialog|script)\b/);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const a = doc.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/products");
    expect(a.className).toMatch(/min-h-touch/);
    expect(a.textContent!.replace(/\s+/g, " ").trim()).toBe("All products");
  });

  test("keyboard open/close: native button, aria-haspopup/expanded, Escape (cancel) closes, focus returns, scroll locked while open", () => {
    render(<DepartmentMenu departments={DEPARTMENTS} />);
    const btn = trigger();
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("aria-haspopup", "dialog");
    expect(btn).toHaveAttribute("aria-expanded", "false");
    btn.focus();
    fireEvent.click(btn);
    expect(dialog().open).toBe(true);
    expect(screen.getByRole("dialog", { name: "Shop by department" })).toBe(dialog());
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(document.body.style.overflow).toBe("hidden");
    act(() => void dialog().dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(dialog().open).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expectFocused(btn);
  });

  test("closes on navigation: activating any link closes the drawer and unlocks scroll", () => {
    render(<DepartmentMenu departments={DEPARTMENTS} />);
    for (const name of ["Laptops", "All Electronics"]) {
      fireEvent.click(trigger());
      const link = within(dialog()).getByRole("link", { name, hidden: true });
      link.addEventListener("click", (e) => e.preventDefault());
      fireEvent.click(link);
      expect(dialog().open).toBe(false);
      expect(document.body.style.overflow).toBe("");
    }
  });

  test("two levels only: grandchildren never rendered; all hrefs pass isAllowedInternalHref", () => {
    render(<DepartmentMenu departments={DEPARTMENTS} />);
    fireEvent.click(trigger());
    const d = dialog();
    expect(d.textContent).not.toContain("Too deep");
    expect(d.querySelectorAll("details details")).toHaveLength(0);
    expect(d.querySelectorAll("ul ul ul")).toHaveLength(0);
    const hrefs = Array.from(d.querySelectorAll("a")).map((a) => a.getAttribute("href")!);
    expect(hrefs.length).toBeGreaterThan(3);
    for (const h of hrefs) expect(isAllowedInternalHref(h)).toBe(true);
  });

  test("hostile slugs / nav hrefs are encoded or rejected; hostile names and signedInName are text", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const depts: DepartmentInput[] = [
        { ...cat("h", "x?y#z/../w", HOSTILE, null), children: [cat("hc", "..", RTL, "h"), cat("hl", "ok", LONG_WORD, "h")] },
      ];
      const model = buildMenuModel({
        departments: depts,
        primaryNav: [{ label: "JS", href: "javascript:alert(1)" }, { label: "P", href: "//evil.example" }, { label: "Deals", href: "/deals" }],
        accountNav: [{ label: "Ext", href: "https://evil.example" }],
      });
      for (const d of model.departments) {
        if (d.allHref) expect(isAllowedInternalHref(d.allHref)).toBe(true);
        for (const c of d.children) expect(isAllowedInternalHref(c.href)).toBe(true);
      }
      expect(model.primary.map((l) => l.href)).toEqual(["/deals"]);
      expect(model.account).toEqual([]);
      render(<DepartmentMenu departments={depts} signedInName={HOSTILE} />);
      fireEvent.click(trigger());
      expect(dialog().querySelector("img, script")).toBeNull();
      expect(dialog().textContent).toContain(`Hello, ${HOSTILE}`);
      for (const a of Array.from(dialog().querySelectorAll("a"))) expect(a.className).toMatch(/break-words|min-h-touch/);
    } finally {
      console.warn = warn;
    }
  });

  test("SR6: every link, summary and button inside the drawer is >= 44px", () => {
    render(<DepartmentMenu departments={DEPARTMENTS} />);
    expect(trigger().className).toMatch(/min-h-touch/);
    fireEvent.click(trigger());
    for (const el of Array.from(dialog().querySelectorAll("a, summary, button"))) {
      expect(`${el.tagName} ${el.className}`).toMatch(/min-h-touch|size-touch/);
    }
  });
});
