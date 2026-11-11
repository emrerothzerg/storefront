/**
 * Phase 3 redesign guards (T133). Owner: qa-engineer. See tests/redesign/PLAN.md.
 *
 * Run alone (never the full suite):  bun test tests/redesign/guards.test.ts
 * Force every guard on, ignoring the pending list (status reports):
 *   REDESIGN_GUARDS_ALL=1 bun test tests/redesign/guards.test.ts
 *
 * Guards in PENDING_UNTIL_T174 are expected to fail until the redesign lands.
 * They are registered with `test.skipIf` so they show up as "skip" in the
 * output. T174 empties the list; nothing else in the repo is skipped.
 *
 * Memory: files are streamed line by line (node:readline), only hits are kept,
 * and the walk skips node_modules, .next, dot-directories and binaries. No DOM
 * node is ever passed to `expect`.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { createReadStream, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { render, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// THE skip list. Guard ids that are expected to fail until the redesign lands.
// T174 removes every entry (acceptance: the guards pass with this list empty).
// Do not add `.skip` anywhere else.
// ---------------------------------------------------------------------------
export const PENDING_UNTIL_T174: readonly GuardId[] = [];

export type GuardId =
  | "G01-no-retailer-brand-strings"
  | "G02-light-only-strings"
  | "G03-brand-site-constant"
  | "G04-brand-metadata"
  | "G05-brand-header"
  | "G06-brand-footer"
  | "G07-brand-manifest"
  | "G08-theme-color-matches-primary"
  | "G09-brand-jsonld-organization"
  | "G10-primary-hue-not-red"
  | "G11-primary-hue-not-reference"
  | "G12-color-scheme-light-only";

const ALL_GUARDS = process.env.REDESIGN_GUARDS_ALL === "1";
function pending(id: GuardId): boolean {
  return !ALL_GUARDS && PENDING_UNTIL_T174.includes(id);
}
function guard(id: GuardId, title: string, fn: () => void | Promise<void>): void {
  test.skipIf(pending(id))(`${id}: ${title}`, fn);
}

const BRAND = "Northwind Goods";
const ROOT = join(import.meta.dir, "..", "..");
const rel = (p: string): string => relative(ROOT, p).split(sep).join("/");

// ---------------------------------------------------------------------------
// Text scan (G01, G02)
// ---------------------------------------------------------------------------
const SCAN_ROOTS = ["src", "public"];
const SKIP_DIRS = new Set(["node_modules", ".next", "tests"]);
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".md", ".mdx", ".json",
  ".svg", ".txt", ".html", ".xml", ".webmanifest", ".yml", ".yaml",
]);

/** R2 retailer strings, case-insensitive. `anko` needs a non-letter before it
 *  (identifiers such as `rankOf` would otherwise match); see PLAN deviations. */
export const BRAND_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: "kmart", re: /kmart/i },
  { label: "onepass", re: /onepass/i },
  { label: "anko", re: /(?<![a-z])anko/i },
  { label: "afterpay", re: /afterpay/i },
  { label: "zip pay", re: /zip pay/i },
];

/** R1 dark-mode strings, exact case. */
export const LIGHT_ONLY_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: "dark:", re: /dark:/ },
  { label: "prefers-color-scheme", re: /prefers-color-scheme/ },
  { label: "data-theme", re: /data-theme/ },
  { label: "color-scheme: light dark", re: /color-scheme:\s*light\s+dark/ },
];

/**
 * Colocated tests the backlog REQUIRES to contain the forbidden strings as
 * negative greps (T130 AC6, T132 AC2). Hits there are ignored; nothing else is.
 */
export const NEGATIVE_GREP_TESTS: ReadonlyArray<RegExp> = [
  // T130 AC6 as delivered by the designer (P3-D1): light-only negative greps.
  // T174: the globals.test and StoreBadge/PaymentMark exemptions were dropped
  // (those files no longer carry literals); a guard below fails when an
  // exemption becomes stale, so the list can only shrink.
  /^src\/components\/atoms\/tokens\.phase3\.test\.ts$/,
];

/**
 * Light-only patterns are tolerated in prose that states the rule (globals.css
 * header, atoms README "light-only rule", T131 AC8): Markdown lines and CSS
 * comment lines that also carry a negation. Brand patterns are never tolerated.
 */
const NEGATION = /\b(no|not|never|without|don't|do not|banned|forbidden|removed?)\b/i;

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly label: string;
  readonly text: string;
}
interface ScanResult {
  readonly files: number;
  readonly brand: Hit[];
  readonly lightOnly: Hit[];
  readonly tolerated: Hit[];
  /** Hits inside NEGATIVE_GREP_TESTS files (ignored by G01/G02, used by the staleness check). */
  readonly exempt?: Hit[];
  /** Relative paths of every scanned file. */
  readonly paths?: string[];
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, out);
    else if (info.isFile() && TEXT_EXTENSIONS.has(extname(name).toLowerCase())) out.push(full);
  }
}

async function scanFile(path: string, result: ScanResult): Promise<void> {
  const file = rel(path);
  const exempt = NEGATIVE_GREP_TESTS.some((re) => re.test(file));
  const isMarkdown = /\.mdx?$/.test(file);
  const isCss = file.endsWith(".css");
  let inCssComment = false;
  let lineNo = 0;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    lineNo += 1;
    if (line.includes("\u0000")) break; // binary content behind a text extension
    // CSS comment state: is any part of this line inside /* ... */ ?
    let lineIsComment = false;
    if (isCss) {
      const startsInComment = inCssComment;
      const opens = line.lastIndexOf("/*");
      const closes = line.lastIndexOf("*/");
      if (opens > closes) inCssComment = true;
      else if (closes > opens) inCssComment = false;
      const trimmed = line.trim();
      lineIsComment = startsInComment || trimmed.startsWith("/*") || trimmed.startsWith("*");
    }
    if (exempt) {
      for (const { label, re } of [...BRAND_PATTERNS, ...LIGHT_ONLY_PATTERNS]) {
        if (re.test(line)) result.exempt?.push({ file, line: lineNo, label, text: line.trim().slice(0, 160) });
      }
      continue;
    }
    for (const { label, re } of BRAND_PATTERNS) {
      if (re.test(line)) result.brand.push({ file, line: lineNo, label, text: line.trim().slice(0, 160) });
    }
    for (const { label, re } of LIGHT_ONLY_PATTERNS) {
      if (!re.test(line)) continue;
      const hit = { file, line: lineNo, label, text: line.trim().slice(0, 160) };
      if ((isMarkdown || lineIsComment) && NEGATION.test(line)) result.tolerated.push(hit);
      else result.lightOnly.push(hit);
    }
  }
}

let scanPromise: Promise<ScanResult> | undefined;
function scan(): Promise<ScanResult> {
  scanPromise ??= (async () => {
    const files: string[] = [];
    for (const root of SCAN_ROOTS) walk(join(ROOT, root), files);
    const result: ScanResult = { files: files.length, brand: [], lightOnly: [], tolerated: [], exempt: [], paths: files.map(rel) };
    // Sequential on purpose: one open stream at a time keeps memory flat.
    for (const path of files) await scanFile(path, result);
    return result;
  })();
  return scanPromise;
}

const formatHits = (hits: readonly Hit[]): string =>
  hits.map((h) => `${h.file}:${h.line} [${h.label}] ${h.text}`).join("\n");

// ---------------------------------------------------------------------------
// Colour parsing (G08, G10, G11, G12). Values are read from files, never
// embedded here.
// ---------------------------------------------------------------------------
const GLOBALS_CSS = join(ROOT, "src/app/globals.css");
const ATOMS_README = join(ROOT, "src/components/atoms/README.md");

/** Reference hues measured from design-reference/*.png (dominant bins of
 *  saturated pixels, 5-degree bins): teal band 170, purple membership strip 270. */
const REFERENCE_HUES: Readonly<Record<string, number>> = { teal: 170, purple: 270 };
const MIN_REFERENCE_DISTANCE = 30;

/** Retailer red window (wraps through 0). T133 used 345-20; the reference
 *  red/pink measured ~340 deg, so T174 widened it to 335-20 (STATE.md ruling). */
export const RED_WINDOW = { from: 335, to: 20 } as const;
export function inRedWindow(hue: number): boolean {
  return hue >= RED_WINDOW.from || hue <= RED_WINDOW.to;
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Declarations of the top-level `:root { ... }` blocks (never inside @media). */
function rootDeclarations(css: string): Map<string, string> {
  const src = stripCssComments(css);
  const decls = new Map<string, string>();
  let depth = 0;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") {
      const selector = src.slice(src.lastIndexOf("}", i) + 1, i).replace(/^[\s\S]*;/, "").trim();
      if (depth === 0 && /^:root\b/.test(selector)) {
        const end = src.indexOf("}", i);
        for (const m of src.slice(i + 1, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
          if (m[1] && m[2] && !decls.has(m[1])) decls.set(m[1], m[2].trim());
        }
        i = end;
        continue;
      }
      depth += 1;
    } else if (ch === "}") depth = Math.max(0, depth - 1);
  }
  return decls;
}

/** `--color-<role>: var(--raw)` mappings from every @theme block. */
function themeMappings(css: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of stripCssComments(css).matchAll(/--color-([a-z0-9-]+)\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/gi)) {
    if (m[1] && m[2] && !map.has(m[1])) map.set(m[1], m[2]);
  }
  return map;
}

/** Tailwind colour role the atoms README documents as the primary action. */
export function documentedPrimaryRole(readme: string): string | null {
  for (const line of readme.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 3 || !/^primary\b/i.test(cells[1] ?? "")) continue;
    const m = /(?:^|[\s`])bg-([a-z][a-z0-9-]*)/.exec(cells.slice(2).join(" "));
    if (m?.[1]) return m[1];
  }
  const named = /primary[^\n|]*?`--(?:color-)?([a-z][a-z0-9-]*)`/i.exec(readme);
  return named?.[1] ?? null;
}

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function oklabToRgb(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const [r, g, bl] = lin.map((c) => {
    const v = clamp01(c);
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  });
  return { r: r ?? 0, g: g ?? 0, b: bl ?? 0 };
}

function num(token: string | undefined, scale = 1): number {
  if (token === undefined) return Number.NaN;
  const t = token.trim();
  if (t.endsWith("%")) return (Number.parseFloat(t) / 100) * scale;
  return Number.parseFloat(t);
}

/** Parses hex, rgb()/rgba(), hsl()/hsla(), oklch() and oklab(); null otherwise. */
export function parseCssColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  const hex = /^\x23([0-9a-f]{3,8})$/.exec(v);
  if (hex?.[1]) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: Number.parseInt(h.slice(0, 2), 16), g: Number.parseInt(h.slice(2, 4), 16), b: Number.parseInt(h.slice(4, 6), 16) };
  }
  const fn = /^([a-z]+)\(([^)]*)\)$/.exec(v);
  if (!fn?.[1] || fn[2] === undefined) return null;
  const parts = fn[2].split("/")[0]!.split(/[\s,]+/).filter(Boolean);
  switch (fn[1]) {
    case "rgb":
    case "rgba": {
      const [r, g, b] = parts.map((p) => num(p, 255));
      return [r, g, b].every((c) => Number.isFinite(c)) ? { r: r!, g: g!, b: b! } : null;
    }
    case "hsl":
    case "hsla": {
      const h = num(parts[0]);
      const s = num(parts[1], 1) / (parts[1]?.endsWith("%") ? 1 : 100);
      const l = num(parts[2], 1) / (parts[2]?.endsWith("%") ? 1 : 100);
      if (![h, s, l].every(Number.isFinite)) return null;
      const k = (n: number) => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = (n: number) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
      return { r: f(0), g: f(8), b: f(4) };
    }
    case "oklch": {
      const L = num(parts[0], 1);
      const C = num(parts[1], 0.4);
      const H = num(parts[2]);
      if (![L, C, H].every(Number.isFinite)) return null;
      return oklabToRgb(L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180));
    }
    case "oklab": {
      const [L, a, b] = [num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4)];
      return [L, a, b].every(Number.isFinite) ? oklabToRgb(L, a, b) : null;
    }
    default:
      return null;
  }
}

/** HSL hue in degrees [0, 360); null for achromatic colours. */
export function hueOf({ r, g, b }: Rgb): number | null {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  if (d < 1e-6) return null;
  let h: number;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return (h * 60 + 360) % 360;
}

const hueDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

interface PrimaryReading {
  readonly role: string | null;
  readonly rawName: string | null;
  readonly rawValue: string | null;
  readonly rgb: Rgb | null;
  readonly hue: number | null;
  readonly description: string;
}

function readPrimary(): PrimaryReading {
  const readme = readFileSync(ATOMS_README, "utf8");
  const css = readFileSync(GLOBALS_CSS, "utf8");
  const role = documentedPrimaryRole(readme);
  const rawName = role === null ? null : (themeMappings(css).get(role) ?? `--${role}`);
  const decls = rootDeclarations(css);
  let rawValue = rawName === null ? null : (decls.get(rawName) ?? null);
  // Follow var(--x) chains inside :root (max 5 hops).
  for (let hop = 0; hop < 5 && rawValue !== null; hop += 1) {
    const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(rawValue);
    if (!ref?.[1]) break;
    rawValue = decls.get(ref[1]) ?? null;
  }
  const rgb = rawValue === null ? null : parseCssColor(rawValue);
  const hue = rgb === null ? null : hueOf(rgb);
  const rgbText = rgb === null ? "unparsed" : `rgb(${Math.round(rgb.r)} ${Math.round(rgb.g)} ${Math.round(rgb.b)})`;
  const description =
    `atoms README primary role: ${role === null ? "NOT FOUND" : `bg-${role}`}; ` +
    `raw token: ${rawName ?? "n/a"}; value in :root of globals.css: ${rawValue ?? "NOT FOUND"}; ` +
    `${rgbText}; hue: ${hue === null ? "none (achromatic or unparsed)" : `${hue.toFixed(1)} deg`}`;
  return { role, rawName, rawValue, rgb, hue, description };
}

// ---------------------------------------------------------------------------
// Module setup for the brand guards: stub what only works inside Next, use an
// unseeded in-memory DB (the header's readers are failure-isolated).
// ---------------------------------------------------------------------------
mock.module("next/font/google", () => {
  const font = () => ({ variable: "font-stub", className: "font-stub", style: { fontFamily: "stub" } });
  return { Geist: font, Geist_Mono: font };
});
mock.module("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const site = await import("@/lib/seo/site");
const { organizationJsonLd } = await import("@/lib/seo/json-ld");
const manifestModule = await import("@/app/manifest");
const layoutModule = await import("@/app/layout");
const { HeaderShell } = await import("@/app/_layout/HeaderShell");
const { SiteFooter } = await import("@/components/organisms/SiteFooter");
const { closeDatabase } = await import("@/server/db/client");

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

function collect(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child as ReactNode, out);
    return;
  }
  if (!isValidElement(node)) return;
  out.push(node);
  const children = (node.props as { children?: ReactNode }).children;
  if (children !== undefined) collect(children, out);
}

function layoutElements(): ReactElement[] {
  const tree = layoutModule.default({
    children: createElement("p", null, "page"),
    params: Promise.resolve({}),
  } as Parameters<typeof layoutModule.default>[0]);
  const out: ReactElement[] = [];
  collect(tree, out);
  return out;
}

function jsonLdObjects(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const el of layoutElements()) {
    const data = (el.props as { data?: unknown }).data;
    if (data === undefined || typeof el.type === "string") continue;
    for (const item of Array.isArray(data) ? data : [data]) {
      if (item !== null && typeof item === "object") out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------
describe("redesign guards (T133)", () => {
  test("PENDING_UNTIL_T174 only names known guards, without duplicates", () => {
    const known: readonly GuardId[] = [
      "G01-no-retailer-brand-strings", "G02-light-only-strings", "G03-brand-site-constant",
      "G04-brand-metadata", "G05-brand-header", "G06-brand-footer", "G07-brand-manifest",
      "G08-theme-color-matches-primary", "G09-brand-jsonld-organization", "G10-primary-hue-not-red",
      "G11-primary-hue-not-reference", "G12-color-scheme-light-only",
    ];
    expect(PENDING_UNTIL_T174.filter((id) => !known.includes(id))).toEqual([]);
    expect(new Set(PENDING_UNTIL_T174).size).toBe(PENDING_UNTIL_T174.length);
  });

  test("scan sanity: walks src/** and public/** including colocated test files and SVGs", async () => {
    const result = await scan();
    expect(result.files).toBeGreaterThan(100);
    const paths = result.paths ?? [];
    const has = (re: RegExp) => paths.some((p) => re.test(p));
    expect({
      srcTests: has(/^src\/.+\.test\.tsx?$/),
      publicSvgs: has(/^public\/images\/.+\.svg$/),
      readmes: has(/^src\/.+README\.md$/),
      globalsCss: paths.includes("src/app/globals.css"),
    }).toEqual({ srcTests: true, publicSvgs: true, readmes: true, globalsCss: true });
    // Only the two scan roots, never tests/** or node_modules.
    expect(paths.filter((p) => !/^(src|public)\//.test(p) || p.includes("node_modules/"))).toEqual([]);
  });

  test("T174: every NEGATIVE_GREP_TESTS exemption still matches a file with a forbidden literal (no stale exemptions)", async () => {
    const result = await scan();
    const paths = result.paths ?? [];
    const stale = NEGATIVE_GREP_TESTS.filter((re) => {
      const matched = paths.filter((p) => re.test(p));
      return matched.length === 0 || !(result.exempt ?? []).some((h) => re.test(h.file));
    }).map(String);
    expect(stale).toEqual([]);
  });

  guard("G01-no-retailer-brand-strings", "no kmart/onepass/anko/afterpay/zip pay in src/** or public/**", async () => {
    const { brand } = await scan();
    expect(formatHits(brand)).toBe("");
  });

  guard("G02-light-only-strings", "no dark:, prefers-color-scheme, data-theme, color-scheme: light dark", async () => {
    const { lightOnly } = await scan();
    expect(formatHits(lightOnly)).toBe("");
  });

  guard("G03-brand-site-constant", "SITE_NAME in src/lib/seo/site.ts is the brand", () => {
    expect(site.SITE_NAME).toBe(BRAND);
    expect(site.SITE_DESCRIPTION.includes(BRAND)).toBe(true);
  });

  guard("G04-brand-metadata", "root layout metadata title, applicationName and og:site_name", () => {
    const { metadata } = layoutModule;
    const title = metadata.title as { default?: string; template?: string } | undefined;
    expect(title?.default).toBe(BRAND);
    expect(title?.template).toBe(`%s | ${BRAND}`);
    expect(metadata.applicationName).toBe(BRAND);
    expect((metadata.openGraph as { siteName?: string } | undefined)?.siteName).toBe(BRAND);
  });

  guard("G05-brand-header", "rendered header (HeaderShell) has a home link named after the brand", async () => {
    const view = render(await HeaderShell());
    const banner = view.getByRole("banner");
    const home = within(banner)
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/" && (a.textContent ?? "").includes(BRAND));
    expect(home.length).toBeGreaterThanOrEqual(1);
    view.unmount();
  });

  guard("G06-brand-footer", "rendered footer from the root layout shows the brand", () => {
    const footers = layoutElements().filter((e) => e.type === SiteFooter);
    expect(footers.length).toBe(1);
    const view = render(footers[0]!);
    const text = view.getByRole("contentinfo").textContent ?? "";
    expect(text.includes(BRAND)).toBe(true);
    expect(/\bStorefront\b/.test(text)).toBe(false);
    view.unmount();
  });

  guard("G07-brand-manifest", "web manifest name is the brand", () => {
    const m = manifestModule.default();
    expect(m.name).toBe(BRAND);
    expect(String(m.short_name ?? "").startsWith("Northwind")).toBe(true);
  });

  guard("G08-theme-color-matches-primary", "manifest theme_color (and viewport.themeColor if set) equals the primary raw value", () => {
    const primary = readPrimary();
    const expected = primary.rgb;
    const m = manifestModule.default();
    const got = parseCssColor(String(m.theme_color ?? ""));
    const same = (a: Rgb | null, b: Rgb | null) =>
      a !== null && b !== null && Math.round(a.r) === Math.round(b.r) && Math.round(a.g) === Math.round(b.g) && Math.round(a.b) === Math.round(b.b);
    expect(`manifest theme_color ${String(m.theme_color)} matches: ${same(got, expected)} (${primary.description})`).toBe(
      `manifest theme_color ${String(m.theme_color)} matches: true (${primary.description})`,
    );
    const viewport = (layoutModule as { viewport?: { themeColor?: unknown } }).viewport;
    if (viewport?.themeColor !== undefined) {
      expect(typeof viewport.themeColor).toBe("string");
      expect(same(parseCssColor(String(viewport.themeColor)), expected)).toBe(true);
    }
  });

  guard("G09-brand-jsonld-organization", "Organization (and WebSite) JSON-LD in the root layout name the brand", () => {
    expect(organizationJsonLd().name).toBe(BRAND);
    const objects = jsonLdObjects();
    const orgs = objects.filter((o) => o["@type"] === "Organization");
    expect(orgs.length).toBe(1);
    expect(orgs[0]?.name).toBe(BRAND);
    for (const w of objects.filter((o) => o["@type"] === "WebSite")) expect(w.name).toBe(BRAND);
  });

  guard("G10-primary-hue-not-red", `documented primary hue is outside ${RED_WINDOW.from}-${RED_WINDOW.to} degrees`, () => {
    const p = readPrimary();
    const ok = p.hue !== null && !inRedWindow(p.hue);
    const label = `hue outside ${RED_WINDOW.from}-${RED_WINDOW.to}`;
    expect(`${label}: ${ok} | ${p.description}`).toBe(`${label}: true | ${p.description}`);
  });

  guard("G11-primary-hue-not-reference", "documented primary hue is >= 30 degrees from the reference teal and purple (T130 AC4)", () => {
    const p = readPrimary();
    const distances = Object.entries(REFERENCE_HUES).map(
      ([name, h]) => `${name} ${h} deg: ${p.hue === null ? "n/a" : hueDistance(p.hue, h).toFixed(1)}`,
    );
    const ok = p.hue !== null && Object.values(REFERENCE_HUES).every((h) => hueDistance(p.hue!, h) >= MIN_REFERENCE_DISTANCE);
    const detail = `${distances.join(", ")} | ${p.description}`;
    expect(`distance >= ${MIN_REFERENCE_DISTANCE}: ${ok} | ${detail}`).toBe(`distance >= ${MIN_REFERENCE_DISTANCE}: true | ${detail}`);
  });

  guard("G12-color-scheme-light-only", "every color-scheme declaration in globals.css is exactly `light` (T130 AC1)", () => {
    const css = stripCssComments(readFileSync(GLOBALS_CSS, "utf8"));
    const values = [...css.matchAll(/color-scheme\s*:\s*([^;]+);/g)].map((m) => (m[1] ?? "").trim());
    expect(values.length).toBeGreaterThanOrEqual(1);
    expect(values.filter((v) => v !== "light")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-tests for the parsers (always active; keep the guards honest).
// ---------------------------------------------------------------------------
describe("guard helpers", () => {
  test("parseCssColor + hueOf: hex short/long, rgb, hsl, oklch, unknown", () => {
    const hex = (s: string) => `\x23${s}`;
    expect(hueOf(parseCssColor(hex("f00"))!)).toBe(0);
    expect(Math.round(hueOf(parseCssColor(hex("00ff00"))!)!)).toBe(120);
    expect(Math.round(hueOf(parseCssColor("rgb(0 0 255)")!)!)).toBe(240);
    expect(Math.round(hueOf(parseCssColor("rgba(0, 128, 128, 0.5)")!)!)).toBe(180);
    expect(Math.round(hueOf(parseCssColor("hsl(30 100% 50%)")!)!)).toBe(30);
    const oklch = hueOf(parseCssColor("oklch(0.55 0.2 264)")!);
    expect(oklch !== null && oklch > 200 && oklch < 260).toBe(true);
    expect(hueOf(parseCssColor(hex("777777"))!)).toBeNull();
    expect(parseCssColor("currentColor")).toBeNull();
    expect(parseCssColor(hex("12345"))).toBeNull();
  });

  test("red window is 335-20 (T174) and wraps around 0", () => {
    expect(RED_WINDOW).toEqual({ from: 335, to: 20 });
    expect([334, 335, 340, 359, 0, 20, 21, 224].map((h) => `${h}:${inRedWindow(h)}`)).toEqual([
      "334:false", "335:true", "340:true", "359:true", "0:true", "20:true", "21:false", "224:false",
    ]);
  });

  test("hue window and reference distance wrap around 0", () => {
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(170, 175)).toBe(5);
    expect(hueDistance(0, 180)).toBe(180);
  });

  test("documentedPrimaryRole reads the README table row, ignoring variant prefixes", () => {
    expect(documentedPrimaryRole("| Role | Utilities |\n| Primary action | `bg-brand hover:bg-brand-hover text-x` |")).toBe("brand");
    expect(documentedPrimaryRole("| Primary | `hover:bg-x bg-primary` |")).toBe("primary");
    expect(documentedPrimaryRole("primary colour token: `--color-indigo`")).toBe("indigo");
    expect(documentedPrimaryRole("nothing here")).toBeNull();
  });

  test("rootDeclarations ignores @media blocks and comments; themeMappings resolves roles", () => {
    const css = [
      "/* :root { --accent: red; } */",
      ":root { color-scheme: light; --accent: rgb(1 2 3); --alias: var(--accent); }",
      "@media (min-width: 1px) { :root { --accent: rgb(9 9 9); } }",
      "@theme inline { --color-accent: var(--accent); }",
    ].join("\n");
    expect(rootDeclarations(css).get("--accent")).toBe("rgb(1 2 3)");
    expect(themeMappings(css).get("accent")).toBe("--accent");
  });

  test("scanFile reports file:line, tolerates rule prose only for light-only patterns, stops at binary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "redesign-guards-"));
    try {
      const write = (name: string, body: string) => {
        const path = join(dir, name);
        writeFileSync(path, body);
        return path;
      };
      const result: ScanResult = { files: 0, brand: [], lightOnly: [], tolerated: [] };
      await scanFile(write("a.tsx", 'const a = 1;\nconst c = "dark:bg-x";\n// Shop KMART deals\n'), result);
      await scanFile(write("b.css", "/* LIGHT ONLY: no prefers-color-scheme block.\n   Do not add dark: utilities. */\n:root { color-scheme: light dark; }\n"), result);
      await scanFile(write("c.md", "Never use `data-theme`.\nUse data-theme for dark mode.\nNo Afterpay here.\n"), result);
      await scanFile(write("d.svg", "<svg>ok</svg>\n\u0000 kmart\n"), result);
      const short = (hits: readonly Hit[]) => hits.map((h) => `${h.file.split("/").pop()}:${h.line}:${h.label}`);
      expect(short(result.brand)).toEqual(["a.tsx:3:kmart", "c.md:3:afterpay"]);
      expect(short(result.lightOnly)).toEqual(["a.tsx:2:dark:", "b.css:3:color-scheme: light dark", "c.md:2:data-theme"]);
      expect(short(result.tolerated)).toEqual(["b.css:1:prefers-color-scheme", "b.css:2:dark:", "c.md:1:data-theme"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("patterns: anko needs a non-letter before it; zip pay and dark: match", () => {
    const anko = BRAND_PATTERNS.find((p) => p.label === "anko")!.re;
    expect(anko.test("rankOf")).toBe(false);
    expect(anko.test("Anko kids")).toBe(true);
    expect(anko.test("brand: 'anko'")).toBe(true);
    expect(BRAND_PATTERNS.some((p) => p.re.test("Pay with Zip Pay"))).toBe(true);
    expect(LIGHT_ONLY_PATTERNS.some((p) => p.re.test('className="dark:bg-x"'))).toBe(true);
    expect(LIGHT_ONLY_PATTERNS.some((p) => p.re.test("color-scheme:  light   dark;"))).toBe(true);
    expect(LIGHT_ONLY_PATTERNS.some((p) => p.re.test("color-scheme: light;"))).toBe(false);
  });
});
