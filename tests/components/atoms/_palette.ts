// QA helper (QA-ATOMS-P3): reads the light-only palette straight out of
// src/app/globals.css at test time. Tests never hard-code colour values; every
// ratio is recomputed from the raw :root custom properties parsed here.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..", "..");
export const CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");
/** The leading comment block: the documented token list and contrast table. */
export const HEADER = CSS.match(/^\/\*[\s\S]*?\*\//)?.[0] ?? "";
/** The stylesheet with every comment stripped. */
export const BODY = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
export const README = readFileSync(join(ROOT, "src/components/atoms/README.md"), "utf8");

/** Body of the first top-level `:root { ... }` block (the raw values). */
export const ROOT_BLOCK = BODY.match(/^:root\s*\{([\s\S]*?)\}/m)?.[1] ?? "";

export type RGB = [number, number, number];
export type Palette = Record<string, string>;

/** `--name: <hex>;` declarations of a block (3- or 6-digit hex). */
export function parseHexVars(block: string): Palette {
  const out: Palette = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(\x23[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)\s*;/g)) {
    out[m[1]!] = m[2]!.toLowerCase();
  }
  return out;
}

/** The light (and only) palette. */
export const PALETTE: Palette = parseHexVars(ROOT_BLOCK);

export function hexToRgb(hex: string): RGB {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as RGB;
}

export function rgbToHex(rgb: RGB): string {
  return String.fromCharCode(35) + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

export function luminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRgb(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Raw value of a role (without the leading `--`); throws if it is missing. */
export function raw(token: string): string {
  const v = PALETTE[token];
  if (!v) throw new Error(`globals.css :root has no hex value for --${token}`);
  return v;
}

/** WCAG 2.x contrast of two role tokens, recomputed from the raw values. */
export function ratio(fg: string, bg: string): number {
  return contrastRgb(hexToRgb(raw(fg)), hexToRgb(raw(bg)));
}

/** Alpha-composites `fg` at `alpha` over `bg` (8-bit rounding, as a browser paints it). */
export function composite(fg: RGB, alpha: number, bg: RGB): RGB {
  return fg.map((c, i) => Math.round(alpha * c + (1 - alpha) * bg[i]!)) as RGB;
}

/** `--scrim: rgb(r g b / a)` from the `:root, ::backdrop` block. */
export function parseScrim(): { rgb: RGB; alpha: number } | null {
  const m = BODY.match(
    /:root,\s*::backdrop\s*\{\s*--scrim:\s*rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\);/,
  );
  if (!m) return null;
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

/** HSV/HSL hue in degrees (NaN for greys). */
export function hueOf(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255) as RGB;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return Number.NaN;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Ratio printed the way the header prints it (2 decimals). */
export const fmt = (n: number): string => n.toFixed(2);

/** The "INTENDED COLOUR PAIRS" section of the header (up to the closing marker). */
export const PAIRS_SECTION =
  HEADER.split("INTENDED COLOUR PAIRS")[1]?.split("NOT intended (do not use)")[0] ?? "";

export const SURFACES = ["surface-page", "surface-raised", "surface-sunken"] as const;

/** A documented header row: one foreground over one or more backgrounds. */
export interface HeaderRow {
  line: string;
  fg: string;
  bgs: string[];
  stated: number[];
  /** Minimum the header claims for the row; null for "n/a" (decorative). */
  min: number | null;
}

/**
 * Parses the single-line rows of the form
 *   `<fg> [(note)] on <bg> [/ <bg> ...] [(note)]   <r> [/ <r> ...]   <min>`
 * Background shorthands are resolved the way the header writes them:
 * `raised`/`sunken` -> `surface-*`, `hover`/`active` -> `<first bg>-hover`.
 * Multi-line and table-shaped rows are not matched (tests transcribe those).
 */
export function parseHeaderRows(section: string = PAIRS_SECTION): HeaderRow[] {
  const rows: HeaderRow[] = [];
  const re =
    /^\s*([a-z][a-z-]*)(?:\s*\([^)]*\))?\s+on\s+([a-z][a-z-]*(?:\s*\/\s*[a-z][a-z-]*)*)(?:\s*\([^)]*\))?\s+(\d+\.\d+(?:\s*\/\s*\d+\.\d+)*)\s+(4\.5|3|n\/a)\s*$/;
  for (const line of section.split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    const names = m[2]!.split("/").map((s) => s.trim());
    const first = names[0]!;
    const bgs = names.map((n, i) => resolveBg(n, i === 0 ? null : first));
    rows.push({
      line: line.trim(),
      fg: m[1]!,
      bgs,
      stated: m[3]!.split("/").map((s) => Number(s.trim())),
      min: m[4] === "n/a" ? null : Number(m[4]),
    });
  }
  return rows;
}

function resolveBg(name: string, first: string | null): string {
  if (PALETTE[name]) return name;
  if (PALETTE[`surface-${name}`]) return `surface-${name}`;
  if (first && PALETTE[`${first}-${name}`]) return `${first}-${name}`;
  return name; // unresolved: the caller's assertion reports it
}
