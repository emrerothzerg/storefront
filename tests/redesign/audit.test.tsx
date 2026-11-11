/**
 * T174 — Phase 3 redesign audit (QA-owned). Structural checks across the
 * whole app; see tests/redesign/PLAN.md ("T174 audit") for the run command.
 *
 *   (a) brand-free      copy in src/content, pages (src/app), organisms, SVGs
 *                       under public/images, rendered pages; brand names in
 *                       manifest / metadata / JSON-LD
 *   (b) light-only      no dark/theme handling anywhere, `color-scheme: light`,
 *                       manifest theme colour = primary, no theme toggle
 *   (c) tokens-only     `check:tokens` wrapper, raw hex outside the allowed
 *                       files, arbitrary values in class strings (src/**)
 *   (d) a11y basics     rendered pages (header + main + footer together)
 *   (e) responsive      320px overflow risks from markup + source allow-list
 *
 * Rules kept here: retailer/theme words are assembled at run time (this file
 * never contains them literally), no DOM node is ever passed to `expect`
 * (only strings/arrays), pages are rendered with renderToStaticMarkup and
 * parsed into a detached document (pattern from tests/app/phase2-wave5).
 *
 * Defects found by this audit are pinned at the bottom with `test.failing`
 * and `// PIN: D-T174-n`; flip them to `test` when the owner fixes them.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createSignedInUser,
  installNextMocks,
  outcomeOf,
  parseHtml,
  resetCookies,
} from "../app/phase2-wave5/_harness";

installNextMocks();
mock.module("next/font/google", () => {
  const font = () => ({ variable: "font-stub", className: "font-stub", style: { fontFamily: "stub" } });
  return { Geist: font, Geist_Mono: font };
});

const env = process.env as Record<string, string | undefined>;
const previousDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const { createCartService } = await import("@/server/cart/cart-service");
const { HeaderShell } = await import("@/app/_layout/HeaderShell");
const { SiteFooter } = await import("@/components/organisms/SiteFooter");
const { ToastProvider } = await import("@/components/atoms/Toast");
const { FOOTER_COLUMNS } = await import("@/content/navigation");
const site = await import("@/lib/seo/site");
const { organizationJsonLd, webSiteJsonLd } = await import("@/lib/seo/json-ld");
const { default: manifest } = await import("@/app/manifest");
const layoutModule = await import("@/app/layout");
const { default: HomePage } = await import("@/app/page");
const { default: CategoryPage } = await import("@/app/category/[slug]/page");
const { default: ProductsPage } = await import("@/app/products/page");
const { default: SearchPage } = await import("@/app/search/page");
const { default: ProductPage } = await import("@/app/products/[slug]/page");
const { default: CartPage } = await import("@/app/cart/page");
const { default: CheckoutPage } = await import("@/app/checkout/page");
const { default: AccountPage } = await import("@/app/account/page");
const { default: SignInPage } = await import("@/app/signin/page");
const { default: ShippingPage } = await import("@/app/shipping/page");
const { default: NotFound } = await import("@/app/not-found");

const ROOT = join(import.meta.dir, "..", "..");
const rel = (p: string): string => relative(ROOT, p).split(sep).join("/");
const BRAND = "Northwind Goods";
const j = (...parts: string[]): string => parts.join("");

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set(["node_modules", ".next"]);

function walk(dir: string, accept: (path: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, accept, out);
    else if (info.isFile() && accept(full)) out.push(full);
  }
  return out;
}

const isTestFile = (p: string): boolean => /\.test\.tsx?$/.test(p);
const isCode = (p: string): boolean => [".ts", ".tsx"].includes(extname(p));
const sourceFiles = (dir: string): string[] => walk(join(ROOT, dir), (p) => isCode(p) && !isTestFile(p));

/**
 * Removes `//` and `/* *\/` comments from TS/TSX while keeping string,
 * template and JSX text intact (comments are documentation, not copy).
 * Regex literals are rare in copy files and are treated as code.
 */
export function stripTsComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const body = src.slice(i, end === -1 ? src.length : end + 2);
      out += body.replace(/[^\n]/g, " "); // keep line numbers
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    out += ch;
    i += 1;
  }
  return out;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly label: string;
}
const fmt = (hits: readonly Hit[]): string[] => hits.map((h) => `${h.file}:${h.line} [${h.label}]`);

// ---------------------------------------------------------------------------
// (a) Word lists, built at run time
// ---------------------------------------------------------------------------
interface Word {
  readonly label: string;
  readonly re: RegExp;
}
const w = (label: string, re: RegExp): Word => ({ label, re });
const word = (s: string, flags = "i"): RegExp => new RegExp(`(^|[^a-z0-9])${s.replace(/ /g, "[\\s-]+")}($|[^a-z0-9])`, flags);

const RETAILER: readonly Word[] = [
  w("retailer:" + j("k", "mart"), word(j("k", "mart"))),
  w("retailer:" + j("one", "pass"), word(j("one", "\\s?", "pass"))),
  w("retailer:" + j("an", "ko"), word(j("an", "ko"))),
  w("retailer:assistant " + j("J", "oy"), word(j("J", "oy"), "")),
  w("retailer:" + j("Tar", "get"), word(j("Tar", "get"), "")),
  w("partner:" + j("u", "ber"), word(j("u", "ber"))),
];
const PAYMENT: readonly Word[] = [
  w("payment:" + j("after", "pay"), word(j("after", "pay"))),
  w("payment:" + j("zip", " pay"), word(j("zip", " pay"))),
  w("payment:" + j("pay", "pal"), word(j("pay", "pal"))),
  w("payment:" + j("kla", "rna"), word(j("kla", "rna"))),
  w("payment:" + j("apple", " pay"), word(j("apple", " pay"))),
  w("payment:" + j("google", " pay"), word(j("google", " pay"))),
  w("payment:" + j("vi", "sa"), word(j("vi", "sa"))),
  w("payment:" + j("master", "card"), word(j("master", "card"))),
  w("payment:" + j("american", " express"), word(j("american", " express"))),
  w("payment:" + j("am", "ex"), word(j("am", "ex"))),
  w("payment:pay in 4", word(j("pay", " in 4"))),
];
const SOCIAL: readonly Word[] = [
  w("social:" + j("face", "book"), word(j("face", "book"))),
  w("social:" + j("insta", "gram"), word(j("insta", "gram"))),
  w("social:" + j("twit", "ter"), word(j("twit", "ter"))),
  w("social:" + j("tik", "tok"), word(j("tik", "tok"))),
  w("social:" + j("you", "tube"), word(j("you", "tube"))),
  w("social:" + j("pin", "terest"), word(j("pin", "terest"))),
  w("social:" + j("linked", "in"), word(j("linked", "in"))),
];
const MEMBERSHIP: readonly Word[] = [
  w("membership:" + j("member", "ship"), word(j("member", "ships?"))),
  w("membership:" + j("member", "s"), word(j("member", "s?"))),
  w("membership:" + j("loy", "alty"), word(j("loy", "alty"))),
  w("membership:" + j("re", "wards"), word(j("re", "wards?"))),
];
const NEWSLETTER: readonly Word[] = [
  w("newsletter:" + j("news", "letter"), word(j("news", "letters?"))),
  w("newsletter:subscribe to our", word(j("subscribe", " to our"))),
  w("newsletter:stay in the know", word(j("stay", " in the know"))),
];
const APP_STORE: readonly Word[] = [
  w("app:" + j("app", " store"), word(j("app", " store"))),
  w("app:" + j("google", " play"), word(j("google", " play"))),
  w("app:download the app", word(j("download", " the app"))),
];
/** R2/R6/R10 copied or dishonest copy. */
const COPY: readonly Word[] = [
  w("copy:low prices", word(j("low", " prices"))),
  w("copy:delivered faster", word(j("delivered", " faster"))),
  w("copy:click and collect", new RegExp(j("click", "\\s*(&|and|&amp;)\\s*", "collect"), "i")),
  w("copy:same day", word(j("same", " day"))),
  w("copy:" + j("cata", "logue"), word(j("cata", "logues?"))),
];
/** D-T174-3: the one known content hit (pinned at the bottom of this file). */
const KNOWN_COPY_HIT = new RegExp(j("^src/content/home\\.ts:\\d+ \\[copy:cata", "logue\\]$"));
const ALL_WORDS: readonly Word[] = [...RETAILER, ...PAYMENT, ...SOCIAL, ...MEMBERSHIP, ...NEWSLETTER, ...APP_STORE, ...COPY];

/**
 * Documented exceptions (file, label). Each needs a reason; anything else
 * found is a defect.
 */
const BRAND_ALLOW: ReadonlyArray<{ readonly file: RegExp; readonly label: RegExp; readonly reason: string }> = [
  {
    file: /^src\/components\/organisms\/OrderDetail\/(order-detail-model\.ts|OrderDetail\.tsx)$/,
    label: /^payment:/,
    reason:
      "card network of the shopper's own payment method on their order (\"<network> ending in 4242\"), from the mock provider; data, not a partner logo or offer (observation O-T174-1)",
  },
];

function scanWords(files: readonly string[], words: readonly Word[], transform: (src: string, file: string) => string): Hit[] {
  const hits: Hit[] = [];
  for (const path of files) {
    const file = rel(path);
    const lines = transform(readFileSync(path, "utf8"), file).split("\n");
    lines.forEach((line, idx) => {
      for (const { label, re } of words) {
        if (!re.test(line)) continue;
        if (BRAND_ALLOW.some((a) => a.file.test(file) && a.label.test(label))) continue;
        hits.push({ file, line: idx + 1, label });
      }
    });
  }
  return hits;
}

/** SVG: only text nodes and attribute values a user could see or hear. */
function svgVisibleText(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const texts = [...line.matchAll(/>([^<]+)</g)].map((m) => m[1] ?? "");
      const attrs = [...line.matchAll(/\s(?:aria-label|title|alt|xlink:title)="([^"]*)"/g)].map((m) => m[1] ?? "");
      return [...texts, ...attrs].join(" ");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Rendering (d, e and rendered-copy checks for a, b)
// ---------------------------------------------------------------------------
interface RenderedPage {
  readonly name: string;
  readonly html: string;
  readonly doc: Document;
}

const pages = new Map<string, RenderedPage>();
const OWNER = "a1a1a1a1-0000-4000-8000-0000000000aa";

async function renderPage(name: string, cookies: Record<string, string>, page: () => Promise<ReactNode> | ReactNode): Promise<void> {
  resetCookies(cookies);
  const header = await HeaderShell();
  const outcome = await outcomeOf(async () => page());
  if (outcome.kind !== "ok") throw new Error(`${name}: page outcome ${outcome.kind}`);
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      header,
      createElement("main", { id: "main", tabIndex: -1, className: "flex-1 mx-auto w-full max-w-7xl px-4 py-8" }, outcome.value),
      createElement(SiteFooter, { storeName: site.SITE_NAME, columns: FOOTER_COLUMNS }),
    ),
  );
  pages.set(name, { name, html, doc: parseHtml(html) });
}

const PAGE_NAMES = [
  "home (guest)",
  "home (signed in)",
  "category listing",
  "all products listing",
  "search",
  "product detail",
  "cart (with item)",
  "checkout (with item)",
  "account hub",
  "sign in",
  "static: shipping",
  "not found",
] as const;

beforeAll(async () => {
  closeDatabase();
  const db = getDatabase();
  seedDatabase(db);
  const dept = db.query<{ slug: string }, []>("SELECT slug FROM categories WHERE parent_id IS NULL ORDER BY slug LIMIT 1").get();
  const product = db
    .query<{ id: string; slug: string }, []>(
      "SELECT id, slug FROM products WHERE stock > 5 AND published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY id LIMIT 1",
    )
    .get();
  if (dept === null || product === null) throw new Error("seed missing department/product");
  const user = await createSignedInUser(db, "Audit Shopper", "audit.shopper");
  const added = createCartService(db).addItem(OWNER, product.id, 1);
  if (!added.ok) throw new Error("cart seed failed");
  const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
  const guest = {};
  const cart = { [session.SESSION_COOKIE_NAME]: OWNER };
  const auth = { [session.AUTH_COOKIE_NAME]: user.token };
  type AnyPage = (props: never) => Promise<ReactNode> | ReactNode;
  const call = (fn: unknown, props: unknown) => (fn as AnyPage)(props as never);

  await renderPage("home (guest)", guest, () => call(HomePage, { searchParams: sp() }));
  await renderPage("home (signed in)", auth, () => call(HomePage, { searchParams: sp() }));
  await renderPage("category listing", guest, () => call(CategoryPage, { params: Promise.resolve({ slug: dept.slug }), searchParams: sp() }));
  await renderPage("all products listing", guest, () => call(ProductsPage, { searchParams: sp() }));
  await renderPage("search", guest, () => call(SearchPage, { searchParams: sp({ q: "desk" }) }));
  await renderPage("product detail", guest, () => call(ProductPage, { params: Promise.resolve({ slug: product.slug }), searchParams: sp() }));
  await renderPage("cart (with item)", cart, () => call(CartPage, {}));
  await renderPage("checkout (with item)", cart, () => call(CheckoutPage, {}));
  await renderPage("account hub", auth, () => call(AccountPage, {}));
  await renderPage("sign in", guest, () => call(SignInPage, { searchParams: sp() }));
  await renderPage("static: shipping", guest, () => call(ShippingPage, {}));
  await renderPage("not found", guest, () => call(NotFound, {}));
});

afterAll(() => {
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
});

function page(name: (typeof PAGE_NAMES)[number]): RenderedPage {
  const p = pages.get(name);
  if (p === undefined) throw new Error(`page not rendered: ${name}`);
  return p;
}

/** Runs `check` on every rendered page and returns "page: violation" strings. */
function everyPage(check: (doc: Document, html: string) => readonly string[]): string[] {
  const out: string[] = [];
  for (const name of PAGE_NAMES) {
    const p = page(name);
    for (const v of check(p.doc, p.html)) out.push(`${name}: ${v}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOM analysis helpers (return strings only)
// ---------------------------------------------------------------------------
const classes = (el: Element): string[] => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const short = (el: Element): string => {
  const name = el.getAttribute("aria-label") ?? (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return `${el.tagName.toLowerCase()}"${name.slice(0, 40)}"`;
};

function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return label.trim();
  const by = el.getAttribute("aria-labelledby");
  if (by !== null) {
    return by
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

const SECTIONING = "article, aside, main, nav, section";
function landmarkRole(el: Element): string | null {
  const explicit = el.getAttribute("role");
  if (explicit !== null) {
    return ["banner", "navigation", "main", "complementary", "contentinfo", "region", "search", "form"].includes(explicit) ? explicit : null;
  }
  switch (el.tagName.toLowerCase()) {
    case "header":
      return el.parentElement?.closest(SECTIONING) === null || el.parentElement?.closest(SECTIONING) === undefined ? "banner" : null;
    case "footer":
      return el.parentElement?.closest(SECTIONING) === null || el.parentElement?.closest(SECTIONING) === undefined ? "contentinfo" : null;
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "aside":
      return "complementary";
    case "search":
      return "search";
    case "section":
      return nameOf(el) === "" ? null : "region";
    case "form":
      return nameOf(el) === "" ? null : "form";
    default:
      return null;
  }
}

function landmarkViolations(doc: Document): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const el of doc.body.querySelectorAll("*")) {
    const role = landmarkRole(el);
    if (role === null) continue;
    counts.set(role, (counts.get(role) ?? 0) + 1);
    const name = nameOf(el);
    if (["navigation", "complementary", "search"].includes(role) && name === "") out.push(`unnamed ${role}`);
    if (name !== "") seen.set(`${role}:${name}`, (seen.get(`${role}:${name}`) ?? 0) + 1);
  }
  for (const role of ["banner", "main", "contentinfo"]) {
    if ((counts.get(role) ?? 0) !== 1) out.push(`${role} count ${counts.get(role) ?? 0}`);
  }
  for (const [key, n] of seen) if (n > 1) out.push(`duplicate landmark name ${key} x${n}`);
  return out;
}

function headingIssues(doc: Document): string[] {
  const out: string[] = [];
  const all = [...doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  const h1 = all.filter((h) => h.tagName === "H1").length;
  if (h1 !== 1) out.push(`h1 count ${h1}`);
  const main = doc.getElementById("main");
  const inMain = main === null ? [] : [...main.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName.slice(1)));
  if (inMain[0] !== 1) out.push(`first heading in main is h${inMain[0] ?? "none"}`);
  for (let i = 1; i < inMain.length; i += 1) {
    const prev = inMain[i - 1]!;
    const cur = inMain[i]!;
    if (cur > prev + 1) out.push(`main: skipped h${prev} -> h${cur} at heading #${i + 1}`);
  }
  for (const region of doc.body.querySelectorAll("header, footer")) {
    if (region.closest("main") !== null) continue;
    const levels = [...region.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName.slice(1)));
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i]! > levels[i - 1]! + 1) out.push(`${region.tagName.toLowerCase()}: skipped h${levels[i - 1]} -> h${levels[i]}`);
    }
    if (levels.includes(1)) out.push(`${region.tagName.toLowerCase()} contains an h1`);
  }
  return out;
}

function formIssues(doc: Document): string[] {
  const out: string[] = [];
  const names = new Map<string, number>();
  for (const form of doc.body.querySelectorAll("form")) {
    const name = nameOf(form);
    if (name !== "") {
      names.set(name, (names.get(name) ?? 0) + 1);
      continue;
    }
    // Unnamed forms are not landmarks; they still need a named submit control.
    const submits = [...form.querySelectorAll('button:not([type]), button[type="submit"], input[type="submit"]')];
    const named = submits.some((b) => nameOf(b) !== "" || (b.textContent ?? "").trim() !== "" || (b.getAttribute("value") ?? "") !== "");
    if (!named) out.push(`form without a name or a named submit (action=${form.getAttribute("action") ?? ""})`);
  }
  for (const [name, n] of names) if (n > 1) out.push(`duplicate form name "${name}" x${n}`);
  return out;
}

function imageIssues(doc: Document): string[] {
  return [...doc.body.querySelectorAll("img")].filter((img) => !img.hasAttribute("alt")).map((img) => `img without alt: ${img.getAttribute("src") ?? ""}`);
}

const TOUCH_H = /^(min-h-touch|h-touch|size-touch|min-h-12|h-12|size-12)$/;
const TOUCH_W = /^(min-w-touch|w-touch|size-touch|w-full|min-w-12|w-12|size-12)$/;
const hidden = (el: Element): boolean => el.closest('[hidden], [aria-hidden="true"], .sr-only') !== null;

/** Buttons, selects, summaries, text inputs: 44px tall; icon-only controls 44px wide too. */
function touchIssues(doc: Document): string[] {
  const out: string[] = [];
  const controls = doc.body.querySelectorAll(
    'button, select, summary, textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
  );
  for (const el of controls) {
    if (hidden(el)) continue;
    const cls = classes(el);
    if (!cls.some((c) => TOUCH_H.test(c))) out.push(`no 44px height: ${short(el)}`);
    const iconOnly = (el.textContent ?? "").trim() === "" && el.tagName !== "INPUT" && el.tagName !== "SELECT" && el.tagName !== "TEXTAREA";
    if (iconOnly && !cls.some((c) => TOUCH_W.test(c))) out.push(`icon-only control without 44px width: ${short(el)}`);
  }
  // Links inside nav landmarks (header rows, footer columns, chips, pagination, breadcrumbs) are targets too.
  for (const a of doc.body.querySelectorAll("nav a[href]")) {
    if (hidden(a)) continue;
    if (!classes(a).some((c) => TOUCH_H.test(c))) out.push(`nav link without 44px height: ${short(a)}`);
  }
  // Links styled as pills/buttons (rounded-full + horizontal padding) are controls too.
  for (const a of doc.body.querySelectorAll("a[href]")) {
    if (hidden(a)) continue;
    const cls = classes(a);
    if (cls.includes("rounded-full") && cls.some((c) => /^px-\d/.test(c)) && !cls.some((c) => TOUCH_H.test(c))) {
      out.push(`pill link without 44px height: ${short(a)}`);
    }
  }
  return out;
}

/** Checkboxes/radios: the input or its wrapping label provides a 44px row. */
function checkTargetIssues(doc: Document): string[] {
  const out: string[] = [];
  for (const el of doc.body.querySelectorAll('input[type="checkbox"], input[type="radio"]')) {
    if (hidden(el)) continue;
    const label = el.closest("label") ?? (el.id ? el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
    const own = classes(el).some((c) => TOUCH_H.test(c));
    const viaLabel = label !== null && classes(label).some((c) => TOUCH_H.test(c));
    const viaParent = el.parentElement !== null && classes(el.parentElement).some((c) => TOUCH_H.test(c));
    if (!own && !viaLabel && !viaParent) out.push(`check/radio without a 44px row: ${el.getAttribute("name") ?? ""}`);
  }
  return out;
}

const OUTLINE_REMOVED = /(^|:)(outline-none|outline-hidden|outline-0)$/;
const FOCUS_REPLACEMENT = /^(focus-visible|focus|group-focus-visible|peer-focus-visible):(ring|outline)(-|$)/;
function focusIssues(doc: Document): string[] {
  const out: string[] = [];
  for (const el of doc.body.querySelectorAll("[class]")) {
    const cls = classes(el);
    if (!cls.some((c) => OUTLINE_REMOVED.test(c))) continue;
    if (!cls.some((c) => FOCUS_REPLACEMENT.test(c) && !OUTLINE_REMOVED.test(c))) out.push(`outline removed without a focus replacement: ${short(el)}`);
  }
  for (const el of doc.body.querySelectorAll("[tabindex]")) {
    const t = Number(el.getAttribute("tabindex"));
    if (Number.isFinite(t) && t > 0) out.push(`positive tabindex ${t}: ${short(el)}`);
  }
  return out;
}

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
const PAD_X = /^(p|px|ps|pe|pl|pr)-(0\.5|[1-9]\d*(\.5)?)$/;
const PAD_Y = /^(p|py|pt|pb)-(0\.5|[1-9]\d*(\.5)?)$/;
const isScroller = (el: Element): boolean => classes(el).some((c) => /^overflow(-x)?-(auto|scroll)$/.test(c));

/**
 * Focusables inside a horizontal scroller need room for the 2px ring + 2px
 * offset on both axes: padding (>= 2px) somewhere between the focusable and
 * the scroller, inclusive, horizontally and vertically.
 */
function scrollRowIssues(doc: Document): string[] {
  const out = new Set<string>();
  for (const scroller of doc.body.querySelectorAll("[class]")) {
    if (!isScroller(scroller)) continue;
    for (const el of scroller.querySelectorAll(FOCUSABLE)) {
      if (hidden(el)) continue;
      let x = false;
      let y = false;
      for (let cur = el.parentElement; cur !== null; cur = cur.parentElement) {
        const cls = classes(cur);
        x ||= cls.some((c) => PAD_X.test(c));
        y ||= cls.some((c) => PAD_Y.test(c));
        if (cur === scroller) break;
      }
      if (!x || !y) {
        const where = nameOf(scroller) || nameOf(scroller.parentElement ?? scroller) || classes(scroller).slice(0, 4).join(" ");
        out.add(`scroll row "${where}" clips focus rings (${!x ? "no horizontal" : ""}${!x && !y ? " + " : ""}${!y ? "no vertical" : ""} padding)`);
      }
    }
  }
  return [...out];
}

const FIXED_WIDTH = /^(w|min-w)-(\d+)$/;
/** Unprefixed fixed widths >= 160px outside a scroller and without a small-screen override. */
function fixedWidthIssues(doc: Document): string[] {
  const out = new Set<string>();
  for (const el of doc.body.querySelectorAll("[class]")) {
    const cls = classes(el);
    for (const c of cls) {
      const m = FIXED_WIDTH.exec(c);
      if (m === null || Number(m[2]) < 40) continue;
      let inScroller = false;
      for (let cur = el.parentElement; cur !== null; cur = cur.parentElement) if (isScroller(cur)) inScroller = true;
      const override = cls.some((k) => /^(max-(xs|sm|md):)?(min-w-0|max-w-full|w-full)$/.test(k) && k !== c);
      if (!inScroller && !override) out.add(`${c} on ${short(el)}`);
    }
  }
  return [...out];
}

/** Grid items without `min-w-0` must not contain non-shrinking fixed widths. */
function gridIssues(doc: Document): string[] {
  const out = new Set<string>();
  for (const grid of doc.body.querySelectorAll("[class]")) {
    if (!classes(grid).includes("grid")) continue;
    for (const item of grid.children) {
      if (classes(item).includes("min-w-0")) continue;
      for (const inner of [item, ...item.querySelectorAll("[class]")]) {
        const cls = classes(inner);
        const fixed = cls.find((c) => FIXED_WIDTH.test(c) && Number(FIXED_WIDTH.exec(c)![2]) >= 40);
        if (fixed === undefined) continue;
        let inScroller = false;
        for (let cur: Element | null = inner; cur !== null && cur !== item; cur = cur.parentElement) if (isScroller(cur)) inScroller = true;
        if (!inScroller && !cls.some((k) => /^(max-(xs|sm):)?min-w-0$/.test(k))) out.add(`grid item without min-w-0 holds ${fixed}: ${short(inner)}`);
      }
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Light-only helpers
// ---------------------------------------------------------------------------
const THEME_STRINGS: readonly Word[] = [
  w("dark:", new RegExp(j("(^|[\\s\"'`:])", "dark", ":"))),
  w(j("prefers-", "color-scheme"), new RegExp(j("prefers-", "color-scheme"))),
  w(j("data-", "theme"), new RegExp(j("data-", "theme"))),
  w(j("color-scheme: ", "dark"), new RegExp(j("color-scheme\\s*:\\s*[^;\"'}]*", "dark"))),
];

function cssVar(name: string): string | null {
  const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
  return m?.[1]?.trim().toLowerCase() ?? null;
}

// ===========================================================================
// Helper self-tests: every analysis detects a planted violation (no vacuous passes)
// ===========================================================================
describe("audit helper self-tests (planted violations)", () => {
  const shell = (mainHtml: string, extra = "") =>
    parseHtml(
      `<a href="#main">Skip to content</a><header><nav aria-label="Primary"></nav></header><main id="main">${mainHtml}</main><footer>${extra}</footer>`,
    );

  test("headingIssues: two h1, h1 -> h3 skip, header h1", () => {
    expect(headingIssues(shell("<h1>a</h1><h3>b</h3><h1>c</h1>"))).toEqual([
      "h1 count 2",
      "main: skipped h1 -> h3 at heading #2",
    ]);
    expect(headingIssues(shell("<h2>x</h2><h1>a</h1>"))).toEqual(["first heading in main is h2"]);
  });

  test("landmarkViolations: unnamed nav, duplicate names, two banners", () => {
    const doc = parseHtml(
      '<header></header><header></header><main id="main"><nav></nav><section aria-label="Deals"></section><section aria-label="Deals"></section></main><footer></footer>',
    );
    expect(landmarkViolations(doc).sort()).toEqual(["banner count 2", "duplicate landmark name region:Deals x2", "unnamed navigation"].sort());
  });

  test("formIssues: duplicate named forms and an anonymous form", () => {
    const doc = shell('<form aria-label="Search"></form><form aria-label="Search"></form><form action="/x"><button type="submit"></button></form>');
    expect(formIssues(doc)).toEqual(['form without a name or a named submit (action=/x)', 'duplicate form name "Search" x2']);
  });

  test("imageIssues / touchIssues / checkTargetIssues / focusIssues", () => {
    const doc = shell(
      '<img src="/a.svg"><img src="/b.svg" alt=""><button class="px-2">Go</button><button class="min-h-touch" aria-label="Close"></button>' +
        '<a href="/x" class="rounded-full px-4">Pill</a><nav aria-label="N"><a href="/n">Nav</a></nav><input type="checkbox" name="c"><div class="outline-none">x</div><span tabindex="2">t</span>',
    );
    expect({
      img: imageIssues(doc),
      touch: touchIssues(doc),
      checks: checkTargetIssues(doc),
      focus: focusIssues(doc),
    }).toEqual({
      img: ["img without alt: /a.svg"],
      touch: [
        'no 44px height: button"Go"',
        'icon-only control without 44px width: button"Close"',
        'nav link without 44px height: a"Nav"',
        'pill link without 44px height: a"Pill"',
      ],
      checks: ["check/radio without a 44px row: c"],
      focus: ['outline removed without a focus replacement: div"x"', 'positive tabindex 2: span"t"'],
    });
  });

  test("scrollRowIssues / fixedWidthIssues / gridIssues", () => {
    const doc = shell(
      '<nav aria-label="Tabs" class="overflow-x-auto"><ul class="p-0"><li><a href="/a">A</a></li></ul></nav>' +
        '<div class="overflow-x-auto"><ul class="p-1"><li><a href="/b">B</a></li></ul></div>' +
        '<div class="w-96">wide</div><div class="w-96 max-w-full">ok</div>' +
        '<div class="grid grid-cols-2"><div><span class="min-w-40">c</span></div><div class="min-w-0"><span class="min-w-40">d</span></div></div>',
    );
    expect({
      scroll: scrollRowIssues(doc),
      fixed: fixedWidthIssues(doc),
      grid: gridIssues(doc),
    }).toEqual({
      scroll: ['scroll row "Tabs" clips focus rings (no horizontal + no vertical padding)'],
      fixed: ['w-96 on div"wide"', 'min-w-40 on span"c"', 'min-w-40 on span"d"'],
      grid: ['grid item without min-w-0 holds min-w-40: span"c"'],
    });
  });

  test("stripTsComments keeps strings, JSX text and URLs; drops comments", () => {
    const src = 'const a = "x // not a comment"; // gone\n/* block\n gone */ <p>Keep me</p> `t${1}`';
    const out = stripTsComments(src);
    expect([out.includes("x // not a comment"), out.includes("gone"), out.includes("Keep me"), out.split("\n").length]).toEqual([true, false, true, 3]);
  });
});

// ===========================================================================
// (a) brand-free
// ===========================================================================
describe("(a) brand-free", () => {
  const contentFiles = sourceFiles("src/content");
  const pageFiles = sourceFiles("src/app");
  const organismFiles = sourceFiles("src/components/organisms");
  const svgFiles = walk(join(ROOT, "public/images"), (p) => p.endsWith(".svg"));

  test("scope sanity: content, pages, organisms and placeholder SVGs are found", () => {
    expect({
      content: contentFiles.length > 5,
      pages: pageFiles.length > 40,
      organisms: organismFiles.length > 40,
      svgs: svgFiles.length > 300,
    }).toEqual({ content: true, pages: true, organisms: true, svgs: true });
  });

  test("word-list self-test: lists are built at run time and match their targets", () => {
    const sample = (label: string, text: string) => ALL_WORDS.filter((x) => x.label.startsWith(label) && x.re.test(text)).length > 0;
    expect([
      sample("payment:", `Pay with ${j("Pay", "Pal")}`),
      sample("social:", `Follow us on ${j("Insta", "gram")}`),
      sample("newsletter:", `Join our ${j("news", "letter")}`),
      sample("membership:", `${j("Member", "s")} save more`),
      sample("app:", `Get it on ${j("Google", " Play")}`),
      sample("copy:", j("Click", " & ", "Collect")),
      sample("retailer:", `Hi, I'm ${j("J", "oy")}`),
      // boundaries: no false positives on ordinary words
      sample("payment:", "advisable"),
      sample("retailer:", "rankOf enjoy target"),
      sample("membership:", "remember"),
    ]).toEqual([true, true, true, true, true, true, true, false, false, false]);
  });

  test("src/content/**: no retailer, payment, social, membership, newsletter, app-store or copied copy", () => {
    // D-T174-3 (pinned below) is the only known hit.
    const hits = fmt(scanWords(contentFiles, ALL_WORDS, stripTsComments)).filter((h) => !KNOWN_COPY_HIT.test(h));
    expect(hits).toEqual([]);
  });

  test("pages (src/app/**, non-test): same word lists", () => {
    expect(fmt(scanWords(pageFiles, ALL_WORDS, stripTsComments))).toEqual([]);
  });

  test("organisms (src/components/organisms/**, non-test): same word lists (card-network exception documented)", () => {
    expect(fmt(scanWords(organismFiles, ALL_WORDS, stripTsComments))).toEqual([]);
  });

  test("placeholder SVGs under public/images/**: no visible text or titles with those words", () => {
    expect(fmt(scanWords(svgFiles, ALL_WORDS, svgVisibleText))).toEqual([]);
  });

  test("home art SVGs contain no text at all (T136: palette-only, no text)", () => {
    const withText = walk(join(ROOT, "public/images/home"), (p) => p.endsWith(".svg"))
      .filter((p) => /<text[\s>]|<title[\s>]/.test(readFileSync(p, "utf8")))
      .map(rel);
    expect(withText).toEqual([]);
  });

  test("rendered pages (header + main + footer): no retailer/payment/social/membership/newsletter/app words in visible text", () => {
    expect(
      everyPage((doc) => {
        const text = (doc.body.textContent ?? "").replace(/\s+/g, " ");
        const attrs = [...doc.body.querySelectorAll("[aria-label],[alt],[title],[placeholder]")]
          .map((el) => ["aria-label", "alt", "title", "placeholder"].map((a) => el.getAttribute(a) ?? "").join(" "))
          .join(" ");
        return ALL_WORDS.filter((x) => x.re.test(`${text} ${attrs}`)).map((x) => x.label);
      }).filter((v) => !/^home \((guest|signed in)\): copy:cata/.test(v)), // D-T174-3, pinned below
    ).toEqual([]);
  });

  test("brand name: SITE_NAME, manifest, metadata, Organization + WebSite JSON-LD are all Northwind Goods", () => {
    const m = manifest();
    const meta = layoutModule.metadata;
    const title = meta.title as { default?: string } | undefined;
    expect({
      site: site.SITE_NAME,
      manifestName: m.name,
      manifestShort: String(m.short_name ?? "").startsWith("Northwind"),
      title: title?.default,
      app: meta.applicationName,
      og: (meta.openGraph as { siteName?: string } | undefined)?.siteName,
      org: organizationJsonLd().name,
      web: webSiteJsonLd().name,
    }).toEqual({ site: BRAND, manifestName: BRAND, manifestShort: true, title: BRAND, app: BRAND, og: BRAND, org: BRAND, web: BRAND });
  });

  test("rendered header wordmark and footer carry the brand on every page", () => {
    expect(
      everyPage((doc) => {
        const out: string[] = [];
        const banner = doc.body.querySelector("header");
        const home = [...(banner?.querySelectorAll('a[href="/"]') ?? [])].some((a) => (a.textContent ?? "").includes(BRAND));
        if (!home) out.push("no brand wordmark link in header");
        if (banner?.querySelector('a[href="/"] img') != null) out.push("wordmark uses an image");
        const footer = [...doc.body.querySelectorAll("footer")].find((f) => f.closest("main") === null);
        if (!(footer?.textContent ?? "").includes(BRAND)) out.push("footer without brand");
        return out;
      }),
    ).toEqual([]);
  });
});

// ===========================================================================
// (b) light-only
// ===========================================================================
describe("(b) light-only", () => {
  const roots = ["src", "public"].flatMap((d) =>
    walk(join(ROOT, d), (p) => [".ts", ".tsx", ".css", ".js", ".mjs", ".json", ".svg", ".webmanifest", ".html"].includes(extname(p))),
  );
  const configs = ["next.config.ts", "next.config.mjs", "next.config.js", "postcss.config.mjs", "package.json", "tsconfig.json"]
    .map((f) => join(ROOT, f))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  /** The designer's negative-grep test is exempt (same as guard G02); prose rule lines in CSS comments too. */
  const EXEMPT = /^src\/components\/atoms\/tokens\.phase3\.test\.ts$/;

  test("no dark:/prefers-color-scheme/data-theme/color-scheme dark in src/**, public/** (code + tests) or root configs", () => {
    const files = [...roots, ...configs].filter((p) => !EXEMPT.test(rel(p)));
    const hits = scanWords(files, THEME_STRINGS, (src, file) => (file.endsWith(".css") ? src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")) : src));
    expect(fmt(hits)).toEqual([]);
  });

  test("globals.css declares `color-scheme: light` and nothing else", () => {
    const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const values = [...css.matchAll(/color-scheme\s*:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    expect(values).toEqual(["light"]);
  });

  test("manifest theme_color = the primary raw value (--accent), background = page surface; viewport has one theme colour", () => {
    const m = manifest();
    const viewport = (layoutModule as { viewport?: { themeColor?: unknown; colorScheme?: unknown } }).viewport;
    expect({
      theme: String(m.theme_color).toLowerCase(),
      background: String(m.background_color).toLowerCase(),
      viewportTheme: typeof viewport?.themeColor === "string" ? viewport.themeColor.toLowerCase() : "not a single string",
      colorScheme: viewport?.colorScheme ?? "absent",
    }).toEqual({ theme: cssVar("--accent")!, background: cssVar("--surface-page")!, viewportTheme: cssVar("--accent")!, colorScheme: "absent" });
  });

  test("no theme toggle component, hook or file under src/**", () => {
    const named = walk(join(ROOT, "src"), () => true)
      .map(rel)
      .filter((p) => /theme|dark-?mode|color-?scheme/i.test(p.split("/").pop() ?? ""));
    const code = sourceFiles("src").filter((p) =>
      new RegExp(j("(Theme", "Toggle|use", "Theme|Theme", "Provider|set", "Theme|toggle", "Dark|is", "Dark)\\b")).test(
        stripTsComments(readFileSync(p, "utf8")),
      ),
    );
    expect({ files: named, code: code.map(rel) }).toEqual({ files: [], code: [] });
  });

  test("rendered pages: no theme strings, no dark: class tokens, no theme toggle, no theme script", () => {
    expect(
      everyPage((doc, html) => {
        const out = THEME_STRINGS.filter((x) => x.re.test(html)).map((x) => `string ${x.label}`);
        for (const el of doc.body.querySelectorAll("button, a, input, [role='switch'], [role='button']")) {
          const n = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""} ${el.getAttribute("title") ?? ""}`;
          if (/\btheme\b|dark mode|light mode/i.test(n)) out.push(`toggle-like control "${n.trim().slice(0, 40)}"`);
        }
        for (const s of doc.body.querySelectorAll("script")) {
          if (s.getAttribute("type") === "application/ld+json") continue;
          // React's no-JS form replay shim, emitted only because the test renders client actions
          // as plain functions (real server actions carry $$FORM_ACTION); not a theme/bootstrap script.
          if ((s.textContent ?? "").startsWith('addEventListener("submit"')) continue;
          out.push(`script type=${s.getAttribute("type") ?? "(none)"}`);
        }
        return out;
      }),
    ).toEqual([]);
  });

  test("toast viewport (T162 note): rendered on every page, light tokens only", () => {
    const toastSrc = walk(join(ROOT, "src/components/atoms/Toast"), (p) => isCode(p) && !isTestFile(p))
      .map((p) => readFileSync(p, "utf8"))
      .join("\n");
    expect(THEME_STRINGS.filter((x) => x.re.test(toastSrc)).map((x) => x.label)).toEqual([]);
  });
});

// ===========================================================================
// (c) tokens-only
// ===========================================================================
describe("(c) tokens-only", () => {
  test("`bun run check:tokens` passes (wrapper)", () => {
    const run = Bun.spawnSync(["sh", "scripts/check-tailwind-tokens.sh"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const out = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
    expect({ exit: run.exitCode, ok: /check:tokens: OK/.test(out), tail: run.exitCode === 0 ? "" : out.slice(0, 2000) }).toEqual({
      exit: 0,
      ok: true,
      tail: "",
    });
  });

  // Raw hex only in globals.css (raw palette), site.ts (manifest/viewport
  // colours) and SVG art; seed-images.ts and seed-data generate placeholder
  // product SVGs (art, not UI) and are part of the SVG allowance.
  const HEX_ALLOWED = [
    /^src\/app\/globals\.css$/,
    /^src\/lib\/seo\/site\.ts$/,
    /\.svg$/,
    /^src\/server\/db\/seed-images\.ts$/,
    /^src\/server\/db\/seed-data\//,
  ];
  const HEX = new RegExp(j("\\x23", "([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_])"));

  test("no raw hex colour in shipped code outside globals.css, site.ts and SVG art", () => {
    const files = ["src", "public"].flatMap((d) =>
      walk(join(ROOT, d), (p) => [".ts", ".tsx", ".css", ".js", ".json", ".webmanifest"].includes(extname(p)) && !isTestFile(p)),
    );
    const hits = scanWords(
      files.filter((p) => !HEX_ALLOWED.some((re) => re.test(rel(p)))),
      [w("hex", HEX)],
      (src, file) => (file.endsWith(".css") ? src.replace(/\/\*[\s\S]*?\*\//g, "") : stripTsComments(src)),
    );
    expect(fmt(hits)).toEqual([]);
  });

  /** A class token that is an arbitrary value (`p-[13px]`, `[mask:x]`); arbitrary variants (`[&_li>*]:x`) are fine. */
  function isArbitraryValueToken(token: string): boolean {
    let t = token;
    // strip variant prefixes, including arbitrary variants like [&_li>*]: and data-[x]:
    for (;;) {
      const m = /^(\[[^\]]*\]|[a-z0-9@*-]+(?:-\[[^\]]*\])?(?:\/[a-z0-9-]+)?):/.exec(t);
      if (m === null) break;
      t = t.slice(m[0].length);
    }
    t = t.replace(/^!/, "").replace(/!$/, "");
    if (/^-?[a-z][a-z0-9-]*-\[[^\]]+\](\/[\w.[\]]+)?$/.test(t)) return true;
    if (/^\[[a-z-]+:[^\]]+\]$/.test(t)) return true;
    return false;
  }

  test("arbitrary-value detector self-test", () => {
    expect(
      ["p-[13px]", "md:w-[calc(100%-1rem)]", "[mask-type:luminance]", "hover:bg-[var(--x)]", "[&_li>*]:rounded-full", "data-[state=open]:block", "group-hover/x:underline", "w-full", "a[href]", "[data-filter-panel]"].map(
        isArbitraryValueToken,
      ),
    ).toEqual([true, true, true, true, false, false, false, false, false, false]);
  });

  test("no arbitrary-value utilities in class strings anywhere in src/** (incl. content/lib/server; arbitrary variants allowed)", () => {
    const hits: string[] = [];
    for (const path of sourceFiles("src")) {
      const lines = stripTsComments(readFileSync(path, "utf8")).split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)) {
          const str = m[1] ?? m[2] ?? m[3] ?? "";
          for (const token of str.split(/\s+/)) if (token !== "" && isArbitraryValueToken(token)) hits.push(`${rel(path)}:${i + 1} ${token}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  test("no inline style in rendered pages except next/image and data-driven bar widths (`width:N%`)", () => {
    // Allowed: rating histogram bars and the free-shipping progress bar set `width:<n>%` from data,
    // which no token can express. Anything else (colour, spacing, fixed sizes) is a token bypass.
    expect(
      everyPage((doc) =>
        [...doc.body.querySelectorAll("[style]")]
          .filter((el) => el.tagName !== "IMG")
          .map((el) => (el.getAttribute("style") ?? "").trim().replace(/;$/, ""))
          .filter((s) => !/^width:\s*\d{1,3}(\.\d+)?%$/.test(s))
          .map((s) => `inline style "${s.slice(0, 60)}"`),
      ),
    ).toEqual([]);
  });
});

// ===========================================================================
// (d) a11y basics on rendered pages
// ===========================================================================
describe("(d) a11y basics (header + main + footer rendered together)", () => {
  test("every audited page rendered", () => {
    expect(PAGE_NAMES.filter((n) => !pages.has(n))).toEqual([]);
  });

  test("exactly one h1 per page, first heading in main is the h1, no skipped levels (main, header, footer)", () => {
    expect(everyPage(headingIssues)).toEqual([]);
  });

  test("landmarks: one banner/main/contentinfo; every nav/aside/search named; landmark names unique per role", () => {
    expect(everyPage(landmarkViolations)).toEqual([]);
  });

  test("forms: named forms have unique names; unnamed forms have a named submit control", () => {
    expect(everyPage(formIssues)).toEqual([]);
  });

  test("every <img> has an alt attribute (decorative = empty)", () => {
    expect(everyPage(imageIssues)).toEqual([]);
  });

  test("controls are 44px: buttons/selects/summaries/inputs min-h-touch, icon-only controls min-w-touch, nav and pill links min-h-touch", () => {
    expect(everyPage(touchIssues)).toEqual([]);
  });

  test("checkboxes and radios sit in a 44px row (input, label or parent)", () => {
    expect(everyPage(checkTargetIssues)).toEqual([]);
  });

  test("focus: globals.css draws the 2px :focus-visible ring; no outline removal without a replacement; no positive tabindex", () => {
    const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");
    expect(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus-ring\);\s*outline-offset:\s*2px;/.test(css)).toBe(true);
    expect(everyPage(focusIssues)).toEqual([]);
  });

  test("source: no outline-none/outline-hidden without a focus replacement and no positive tabIndex in src components/app", () => {
    const hits: string[] = [];
    for (const path of [...sourceFiles("src/components"), ...sourceFiles("src/app")]) {
      stripTsComments(readFileSync(path, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)) {
            const tokens = (m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/);
            if (tokens.some((t) => OUTLINE_REMOVED.test(t)) && !tokens.some((t) => FOCUS_REPLACEMENT.test(t) && !OUTLINE_REMOVED.test(t))) {
              hits.push(`${rel(path)}:${i + 1} outline removed`);
            }
          }
          if (/tabIndex=\{\s*[1-9]/.test(line) || /tabindex="[1-9]/.test(line)) hits.push(`${rel(path)}:${i + 1} positive tabIndex`);
        });
    }
    expect(hits).toEqual([]);
  });

  test("skip link is the first focusable element and targets #main", () => {
    expect(
      everyPage((doc) => {
        const first = doc.body.querySelector(FOCUSABLE);
        return first !== null && first.getAttribute("href") === "#main" && (first.textContent ?? "").trim() === "Skip to content"
          ? []
          : [`first focusable is ${first === null ? "none" : short(first)}`];
      }),
    ).toEqual([]);
  });

  test("ids are unique per page (aria-labelledby/for targets resolve)", () => {
    expect(
      everyPage((doc) => {
        const seen = new Map<string, number>();
        for (const el of doc.body.querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
        const dups = [...seen].filter(([, n]) => n > 1).map(([id]) => `duplicate id ${id}`);
        const dangling = [...doc.body.querySelectorAll("[aria-labelledby], [aria-describedby], label[for]")].flatMap((el) =>
          [el.getAttribute("aria-labelledby"), el.getAttribute("aria-describedby"), el.getAttribute("for")]
            .filter((v): v is string => v !== null)
            .flatMap((v) => v.split(/\s+/))
            .filter((id) => id !== "" && doc.getElementById(id) === null)
            .map((id) => `dangling reference ${id}`),
        );
        return [...dups, ...dangling];
      }),
    ).toEqual([]);
  });
});

// ===========================================================================
// (e) responsive (320px) from markup
// ===========================================================================
describe("(e) responsive: no horizontal page scroll risk at 320px", () => {
  test("unprefixed fixed widths >= 160px only inside scroll rows or with a small-screen override", () => {
    expect(everyPage(fixedWidthIssues)).toEqual([]);
  });

  test("grid items without min-w-0 hold no fixed-width content", () => {
    expect(everyPage(gridIssues)).toEqual([]);
  });

  test("product grids are 2 columns at base (never 1) and every grid card wrapper shrinks below xs", () => {
    expect(
      ["category listing", "all products listing", "search"].flatMap((name) => {
        const doc = page(name as (typeof PAGE_NAMES)[number]).doc;
        const grids = [...doc.body.querySelectorAll("ul[class], ol[class]")].filter((g) => classes(g).includes("grid") && g.querySelector('a[href^="/products/"]') !== null);
        if (grids.length === 0) return [`${name}: no product grid`];
        return grids.flatMap((g) => {
          const cls = classes(g);
          const out: string[] = [];
          if (!cls.includes("grid-cols-2")) out.push(`${name}: product grid base columns ${cls.filter((c) => c.startsWith("grid-cols")).join(",")}`);
          if (!cls.includes("min-w-0")) out.push(`${name}: product grid without min-w-0`);
          return out;
        });
      }),
    ).toEqual([]);
  });

  // Every unprefixed fixed width >= 160px in shipped components/pages, with the reason it is safe at 320px.
  const FIXED_WIDTH_ALLOW: Readonly<Record<string, readonly string[]>> = {
    // card tiles (CategoryTile shape="card" sizes): only rendered inside ScrollRail rows
    "src/components/atoms/CategoryTile/CategoryTile.tsx": ["w-40", "w-56"],
    // Dialog size map: the panel also carries max-w-full and the native dialog is capped by the UA
    "src/components/atoms/Dialog/Dialog.tsx": ["w-96", "w-128", "w-192"],
    // Drawer size map: side panels carry max-w-full (w-80 = 320px exactly; Playwright check)
    "src/components/atoms/Drawer/Drawer.tsx": ["w-72", "w-80", "w-96"],
    // ScrollRail item widths: inside the rail's own overflow-x-auto scroller
    "src/components/atoms/ScrollRail/ScrollRail.tsx": ["w-40", "w-56", "w-72"],
    // CategoryNav "More" popover: absolute, anchored end-0, 256px < 320px (Playwright check)
    "src/components/molecules/CategoryNav/CategoryNav.tsx": ["w-64"],
    // ProductCard min width: max-xs:min-w-0 in grids, rails scroll
    "src/components/molecules/ProductCard/ProductCard.tsx": ["min-w-40"],
    // CompareTable product columns: inside the table's overflow-x-auto wrapper
    "src/components/organisms/CompareTable/CompareTable.tsx": ["min-w-40"],
    // ProductGrid: documentation comment only (`min-w-40` cards) — stripped; kept for clarity
    "src/components/organisms/ProductGrid/ProductGrid.tsx": ["min-w-40"],
  };

  test("source: every unprefixed fixed width >= 160px in src/components and src/app is on the documented allow-list", () => {
    const found: string[] = [];
    for (const path of [...sourceFiles("src/components"), ...sourceFiles("src/app")]) {
      const file = rel(path);
      const src = stripTsComments(readFileSync(path, "utf8"));
      for (const m of src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g)) {
        for (const token of (m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/)) {
          const fw = FIXED_WIDTH.exec(token);
          if (fw === null || Number(fw[2]) < 40) continue;
          if (!(FIXED_WIDTH_ALLOW[file] ?? []).includes(token)) found.push(`${file} ${token}`);
        }
      }
    }
    expect([...new Set(found)]).toEqual([]);
  });

  test("scroll rows hold focusables with padding on both axes so the 2px+2px focus ring is not clipped", () => {
    // Known failures are pinned below (D-T174-1, D-T174-2); everything else must pass.
    const known = [/"Top picks lists"/, /"Primary"/];
    expect(everyPage(scrollRowIssues).filter((v) => !known.some((re) => re.test(v)))).toEqual([]);
  });

  test("scroll rows are overflow-x-auto containers (never the page): body/main have no fixed width", () => {
    expect(
      everyPage((doc) => {
        const main = doc.getElementById("main");
        const cls = main === null ? [] : classes(main);
        return cls.some((c) => FIXED_WIDTH.test(c)) || !cls.includes("w-full") ? [`main classes ${cls.join(" ")}`] : [];
      }),
    ).toEqual([]);
  });
});

// ===========================================================================
// Defect pins (flip to `test` when fixed)
// ===========================================================================
describe("T174 defect pins", () => {
  // PIN: D-T174-1 — home `#top-picks` tab row (ProductRail tabs, T153): the
  // nav is the overflow-x-auto scroller and its ul has p-0, so the focus ring
  // (2px + 2px offset) of every tab link is clipped on top, bottom and the
  // first tab's left edge. Same class of bug as D-T143-1 (CategoryNav).
  test("D-T174-1: top-picks tab links keep their focus ring inside the scroll row", () => {
    const issues = scrollRowIssues(page("home (guest)").doc).filter((v) => v.includes('"Top picks lists"'));
    expect(issues).toEqual([]);
  });

  // PIN: D-T174-2 — header CategoryNav (T143) scroll row has py-1 (D-T143-1
  // fix) but no horizontal padding: the first link's left ring edge and the
  // last link's right edge are clipped at the scroll ends.
  test("D-T174-2: CategoryNav scroll row pads both axes", () => {
    const issues = scrollRowIssues(page("home (guest)").doc).filter((v) => v.includes('"Primary"'));
    expect(issues).toEqual([]);
  });

  // PIN: D-T174-3 — src/content/home.ts (T165) promo-pair "New arrivals" blurb reads
  // "The latest additions to the <cata-logue>, …"; CONTRACTS R-6 bans that word in
  // rendered copy (the reference's catalogue strip, R2/R10). Rendered on home.
  test("D-T174-3: home copy does not use the reference's catalogue wording", () => {
    const re = COPY.find((x) => x.label.startsWith("copy:cata"))!.re;
    expect({
      content: fmt(scanWords(sourceFiles("src/content"), [w("copy", re)], stripTsComments)),
      rendered: re.test(page("home (guest)").doc.body.textContent ?? ""),
    }).toEqual({ content: [], rendered: false });
  });
});
