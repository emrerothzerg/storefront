/**
 * T173 (QA wave C2) shared checks for the phase-3 page QA files. QA-owned.
 *
 * Pure markup helpers only: no `mock.module` here. Each test file installs the
 * next/* mocks of the harness it builds on (wave-5 `_harness.ts` or wave-6
 * `_harness.ts`) before importing any page module.
 *
 * Retailer words are assembled at run time so this file itself never contains
 * them (guard G01 scans `src/**` only, but the rule is kept everywhere).
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** Text a screen reader speaks: `textContent` minus `[aria-hidden="true"]` subtrees, whitespace collapsed. */
export function spokenText(el: Element | null | undefined): string | null {
  if (el === null || el === undefined) return null;
  const clone = el.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

const join = (...parts: string[]): string => parts.join("");

/** G-17 / R-2 words, built at run time (case-insensitive). */
export const RETAILER_WORDS: readonly string[] = [
  join("k", "mart"),
  join("one", "pass"),
  join("after", "pay"),
  join("zip", " pay"),
  join("app", " store"),
  join("google", " play"),
  join("pay", "pal"),
];
/** "anko" only at a word start (G-17). */
const ANKO = new RegExp(`(^|[^a-z])${join("an", "ko")}`, "i");
/** Light-only strings (G-17); the class check below covers `dark:` tokens in markup. */
export const THEME_STRINGS: readonly string[] = [join("prefers-", "color-scheme"), join("data-", "theme"), join(" ", "dark", ":")];

/** Retailer/brand words and theme strings found in an HTML string. */
export function brandAndThemeViolations(html: string): string[] {
  const lower = html.toLowerCase();
  const out: string[] = [];
  for (const w of RETAILER_WORDS) if (lower.includes(w)) out.push(`brand:${w}`);
  if (ANKO.test(lower)) out.push("brand:anko");
  for (const s of THEME_STRINGS) if (lower.includes(s)) out.push(`theme:${s.trim()}`);
  return out;
}

/** Elements carrying a class token that starts with `dark:` (R-5). */
export function darkClassTokens(root: Document | Element): string[] {
  const scope = "body" in root ? root.body : root;
  const out: string[] = [];
  const prefix = join("dark", ":");
  for (const el of scope.querySelectorAll("[class]")) {
    for (const token of (el.getAttribute("class") ?? "").split(/\s+/)) {
      if (token.startsWith(prefix) || token.includes(`:${prefix}`)) out.push(token);
    }
  }
  return out;
}

/** G-20: nothing named like a theme toggle. */
export function themeToggles(root: Document | Element): string[] {
  const scope = "body" in root ? root.body : root;
  const re = /theme|dark mode|light mode/i;
  const out: string[] = [];
  for (const el of scope.querySelectorAll("button, a, input, [role='switch'], [role='button']")) {
    const name = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""} ${el.getAttribute("title") ?? ""}`;
    if (re.test(name)) out.push(name.trim());
  }
  return out;
}

function navName(nav: Element): string {
  const label = nav.getAttribute("aria-label");
  if (label !== null) return label.trim();
  const by = nav.getAttribute("aria-labelledby");
  if (by === null) return "";
  return by
    .split(/\s+/)
    .map((id) => nav.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
}

/** Landmark elements whose role is page-level (not scoped to article/aside/main/nav/section). */
function pageLevel(scope: Element, tag: "header" | "footer"): Element[] {
  return [...scope.querySelectorAll(tag)].filter((el) => el.parentElement?.closest("article, aside, main, nav, section") == null);
}

/**
 * G-1/G-3/G-4/G-5 on a document that holds the layout chrome (`withChrome`):
 * one banner, one main (`#main`), one contentinfo, every nav named, nav names unique.
 * With `chrome: false` (page alone) the page must hold no `main` and no explicit banner/contentinfo role.
 */
export function landmarkViolations(root: Document | Element, { chrome }: { chrome: boolean }): string[] {
  const scope = "body" in root ? root.body : root;
  const out: string[] = [];
  // Page alone: the page is rendered inside the layout's <main>, so its own <header>/<footer> are not landmarks;
  // only explicit roles count. With the chrome, page-level header/footer elements are the banner/contentinfo.
  const banners = (chrome ? pageLevel(scope, "header").length : 0) + scope.querySelectorAll('[role="banner"]').length;
  const infos = (chrome ? pageLevel(scope, "footer").length : 0) + scope.querySelectorAll('[role="contentinfo"]').length;
  const mains = scope.querySelectorAll('main, [role="main"]').length;
  const want = chrome ? 1 : 0;
  if (banners !== want) out.push(`banner x${banners}`);
  if (infos !== want) out.push(`contentinfo x${infos}`);
  if (mains !== want) out.push(`main x${mains}`);
  if (chrome && scope.querySelector("main")?.id !== "main") out.push("main id is not #main");
  const names = new Map<string, number>();
  for (const nav of scope.querySelectorAll('nav, [role="navigation"]')) {
    const name = navName(nav);
    if (name === "") out.push("unnamed nav");
    else names.set(name, (names.get(name) ?? 0) + 1);
  }
  for (const [name, n] of names) if (n > 1) out.push(`nav "${name}" x${n}`);
  return out;
}

/**
 * Interactive elements (links, buttons, inputs other than hidden/checkbox/radio,
 * selects, summaries) without a 44px touch-target utility on themselves or an
 * ancestor within 2 levels. Inline text links inside running text are allowed
 * (SR6 exempts inline links) when `allowInline` matches.
 */
export function smallTargets(root: Document | Element, allowInline: (el: Element) => boolean = () => false): string[] {
  const scope = "body" in root ? root.body : root;
  const touch = /(^|\s)(min-h-touch|h-touch|size-touch|min-h-12|h-12|size-12|min-h-11|h-11|size-11)(\s|$)/;
  const out: string[] = [];
  for (const el of scope.querySelectorAll("a[href], button, select, summary, input:not([type='hidden']):not([type='checkbox']):not([type='radio'])")) {
    if (el.closest("[hidden]") !== null) continue;
    if (allowInline(el)) continue;
    let ok = false;
    let cur: Element | null = el;
    for (let depth = 0; cur !== null && depth < 3; depth += 1, cur = cur.parentElement) {
      if (touch.test(cur.getAttribute("class") ?? "")) {
        ok = true;
        break;
      }
    }
    if (!ok) out.push(`${el.tagName.toLowerCase()}:${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 40)}`);
  }
  return out;
}

/** True when `a` comes before `b` in document order. */
export function precedes(a: Element | null, b: Element | null): boolean {
  if (a === null || b === null) return false;
  return (a.compareDocumentPosition(b) & 4) !== 0;
}

/**
 * The page inside the root layout's chrome as far as a unit harness allows:
 * `HeaderShell` (real, cookie-reading) + `<main id="main" tabIndex={-1}>` +
 * `SiteFooter` with the footer columns (fixed clock). `RootLayout` itself is
 * not rendered (it loads `next/font/google` and `<html>`).
 */
export async function withChrome(
  page: ReactElement,
  parts: { HeaderShell: () => Promise<ReactElement>; SiteFooter: unknown; storeName: string; columns: unknown },
): Promise<string> {
  const header = await parts.HeaderShell();
  const footer = createElement(parts.SiteFooter as (p: Record<string, unknown>) => ReactElement, {
    storeName: parts.storeName,
    columns: parts.columns,
    now: Date.UTC(2026, 10, 8),
  });
  const main = createElement("main", { id: "main", tabIndex: -1 }, page);
  return renderToStaticMarkup(createElement("div", { "data-qa-chrome": "" }, header, main, footer));
}

/**
 * Counts clock reads (`Date.now()` and argument-less `new Date()`) while `run`
 * executes. Copy of the wave-6 harness helper (importing that harness would
 * install its own `next/*` mocks).
 */
export async function countClockReads<T>(run: () => Promise<T>): Promise<{ value: T; reads: number; stacks: string[] }> {
  const RealDate = globalThis.Date;
  const stacks: string[] = [];
  const note = (): void => {
    const frames = (new Error().stack ?? "").split("\n").slice(2, 6).map((s) => s.trim());
    stacks.push(frames.join(" <- "));
  };
  class CountingDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...args);
      const argc: number = args.length;
      if (argc === 0) note();
    }
    static override now(): number {
      note();
      return RealDate.now();
    }
  }
  globalThis.Date = CountingDate as DateConstructor;
  try {
    const value = await run();
    return { value, reads: stacks.length, stacks };
  } finally {
    globalThis.Date = RealDate;
  }
}

/**
 * "Light surfaces" inside page content: class tokens that paint a dark or
 * non-token surface (inverse surface, raw palette colours, black/white
 * literals as backgrounds). The footer and toasts may use the inverse surface;
 * pass the page content (`<main>` or the page alone), not the chrome.
 */
export function darkSurfaceTokens(root: Document | Element): string[] {
  const scope = "body" in root ? root.body : root;
  const bad = /^(?:[a-z0-9-]+:)*bg-(?:surface-inverse|inverse|black|(?:gray|slate|zinc|neutral|stone|red|blue|green|indigo|purple|pink|amber|yellow|orange|teal|cyan|sky|emerald|lime|rose|fuchsia|violet)-\d{2,3})$/;
  const out: string[] = [];
  for (const el of scope.querySelectorAll("[class]")) {
    for (const token of (el.getAttribute("class") ?? "").split(/\s+/)) if (bad.test(token)) out.push(token);
  }
  return out;
}
