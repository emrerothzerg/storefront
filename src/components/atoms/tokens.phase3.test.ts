// Designer guard for the Phase 3 light-only token system (src/app/globals.css).
// Recomputes every documented contrast pair and checks the header states it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");
const HEADER = CSS.match(/^\/\*[\s\S]*?\*\//)?.[0] ?? "";
const BODY = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
const ROOT_BLOCK = BODY.match(/^:root\s*\{([\s\S]*?)\}/m)?.[1] ?? "";
const README = readFileSync(join(import.meta.dir, "README.md"), "utf8");

const P: Record<string, string> = {};
for (const m of ROOT_BLOCK.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) P[m[1]!] = m[2]!;

function lum(hex: string): number {
  const h = hex.slice(1);
  const [r, g, b] = [0, 2, 4]
    .map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function ratio(fg: string, bg: string): number {
  const a = P[fg];
  const b = P[bg];
  if (!a || !b) throw new Error(`missing --${fg} or --${bg}`);
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const ROLE_VARS = [
  "surface-page", "surface-raised", "surface-sunken", "surface-inverse",
  "text-primary", "text-secondary", "text-inverse", "text-on-accent",
  "border-default", "border-strong",
  "accent", "accent-hover", "accent-active", "accent-subtle",
  "promo", "promo-hover", "promo-subtle", "deal", "deal-subtle",
  "danger", "danger-subtle", "danger-hover", "success", "success-subtle", "success-hover",
  "warning", "warning-subtle", "info", "info-subtle",
  "rating", "skeleton", "focus-ring", "focus-ring-inverse",
] as const;

// [fg, bg, documented ratio, minimum]
const SURF = ["surface-page", "surface-raised", "surface-sunken"] as const;
const triple = (fg: string, r: readonly [number, number, number], min: number) =>
  SURF.map((s, i) => [fg, s, r[i]!, min] as const);
const tint = (k: string, own: number, primary: number, ring: number, border: number) =>
  [
    [k, `${k}-subtle`, own, 4.5],
    ["text-primary", `${k}-subtle`, primary, 4.5],
    ["focus-ring", `${k}-subtle`, ring, 3],
    ["border-strong", `${k}-subtle`, border, 3],
  ] as const;

const DOCUMENTED: ReadonlyArray<readonly [string, string, number, number]> = [
  ...triple("text-primary", [17.72, 17.72, 16.12], 4.5),
  ...triple("text-secondary", [7.73, 7.73, 7.03], 4.5),
  ...triple("accent", [6.7, 6.7, 6.1], 4.5),
  ...triple("deal", [5.19, 5.19, 4.73], 4.5),
  ...triple("danger", [6.47, 6.47, 5.89], 4.5),
  ...triple("success", [5.02, 5.02, 4.56], 4.5),
  ...triple("warning", [5.87, 5.87, 5.34], 4.5),
  ...triple("info", [5.93, 5.93, 5.4], 4.5),
  ...triple("border-strong", [4.83, 4.83, 4.4], 3),
  ...triple("focus-ring", [5.17, 5.17, 4.7], 3),
  ...triple("rating", [5.02, 5.02, 4.57], 3),
  ["text-inverse", "surface-inverse", 17.72, 4.5],
  ["focus-ring", "surface-inverse", 3.43, 3],
  ["focus-ring-inverse", "surface-inverse", 17.72, 3],
  ["text-on-accent", "accent", 6.7, 4.5],
  ["text-on-accent", "accent-hover", 8.72, 4.5],
  ["text-on-accent", "accent-active", 10.36, 4.5],
  ["text-on-accent", "deal", 5.19, 4.5],
  ["text-on-accent", "danger", 6.47, 4.5],
  ["text-on-accent", "danger-hover", 8.31, 4.5],
  ["text-on-accent", "success", 5.02, 4.5],
  ["text-on-accent", "success-hover", 7.13, 4.5],
  ["text-on-accent", "warning", 5.87, 4.5],
  ["text-on-accent", "info", 5.93, 4.5],
  ["focus-ring-inverse", "accent-hover", 8.72, 3],
  ["focus-ring-inverse", "accent-active", 10.36, 3],
  ["text-primary", "promo", 10.61, 4.5],
  ["text-primary", "promo-hover", 8.25, 4.5],
  ["text-secondary", "promo", 4.63, 4.5],
  ["focus-ring", "promo", 3.1, 3],
  ["accent", "promo", 4.01, 3],
  ["accent", "promo-hover", 3.12, 3],
  ["text-primary", "promo-subtle", 15.91, 4.5],
  ["focus-ring", "promo-subtle", 4.64, 3],
  ["border-strong", "promo-subtle", 4.34, 3],
  ["text-secondary", "promo-subtle", 6.94, 4.5],
  ...tint("accent", 6.16, 16.28, 4.75, 4.44),
  ...tint("deal", 4.89, 16.69, 4.87, 4.55),
  ...tint("danger", 5.91, 16.2, 4.72, 4.42),
  ...tint("success", 4.79, 16.92, 4.94, 4.62),
  ...tint("warning", 5.66, 17.08, 4.98, 4.66),
  ...tint("info", 5.57, 16.62, 4.85, 4.53),
  ["accent", "danger-subtle", 6.13, 4.5],
  ["accent", "success-subtle", 6.4, 4.5],
  ["accent", "warning-subtle", 6.46, 4.5],
  ["accent", "info-subtle", 6.29, 4.5],
  ["accent", "promo-subtle", 6.02, 4.5],
  ["text-primary", "border-default", 13.96, 4.5],
  ["surface-raised", "border-strong", 4.83, 3],
  ["accent", "surface-inverse", 2.64, 0],
];

describe("light mode only", () => {
  test("no dark-theme machinery in the stylesheet", () => {
    expect(BODY).not.toMatch(/prefers-color-scheme/);
    expect(BODY).not.toMatch(/data-theme/);
    expect(BODY).not.toMatch(/\.dark\b/);
    expect(BODY).toMatch(/:root\s*\{\s*color-scheme:\s*light;/);
  });

  test("atoms never use dark: variants", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (/(^|[\s"'`])dark:/.test(readFileSync(p, "utf8"))) hits.push(p);
        }
      }
    };
    walk(import.meta.dir);
    expect(hits).toEqual([]);
  });

  test("README states the rule", () => {
    expect(README).toContain("Light mode only");
  });
});

// Phase 3 ruling D-T130-1: brand distance from the reference retailer.
function hueOf(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(1 + i, 3 + i), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return Number.NaN;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hueDistance = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe("brand distance (D-T130-1)", () => {
  test.each([["accent"], ["promo"], ["deal"]])("--%s hue is >= 30 deg from teal 170 / purple 270 and outside red 345-20", (v) => {
    const h = hueOf(P[v]!);
    expect(hueDistance(h, 170)).toBeGreaterThanOrEqual(30);
    expect(hueDistance(h, 270)).toBeGreaterThanOrEqual(30);
    expect(h >= 345 || h <= 20).toBe(false);
  });
});

describe("role tokens", () => {
  test.each(ROLE_VARS.map((v) => [v]))("--%s is a hex in :root, mapped to --color-*, documented", (v) => {
    expect(P[v]).toMatch(/^#[0-9a-f]{6}$/);
    expect(BODY).toContain(`--color-${v}: var(--${v});`);
    expect(HEADER).toContain(`--color-${v}`);
  });

  test("scrim on :root and ::backdrop, mapped", () => {
    expect(BODY).toMatch(/:root,\s*::backdrop\s*\{\s*--scrim:\s*rgb\(24 24 27 \/ 0\.6\);/);
    expect(BODY).toContain("--color-scrim: var(--scrim);");
  });

  test("price type tokens exist", () => {
    expect(BODY).toMatch(/--text-price:\s*1\.5rem;/);
    expect(BODY).toMatch(/--text-price-lg:\s*2\.25rem;/);
  });

  test("focus: global 2px ring with offset, white ring inside inverse bands only", () => {
    expect(BODY).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus-ring\);\s*outline-offset:\s*2px;/);
    expect(BODY).toMatch(
      /\.bg-surface-inverse :focus-visible\s*\{\s*outline-color:\s*var\(--focus-ring-inverse\);/,
    );
    expect(BODY).not.toContain(".bg-promo :focus-visible");
  });
});

describe("documented contrast pairs (recomputed)", () => {
  test.each(DOCUMENTED.map((p) => [...p]))("%s on %s = %d (min %d)", (fg, bg, stated, min) => {
    const r = ratio(fg, bg);
    expect(r).toBeGreaterThanOrEqual(min);
    expect(Math.abs(r - stated)).toBeLessThanOrEqual(0.011);
    expect(HEADER + README).toContain(stated.toFixed(2));
  });
});
