// QA (T147, Phase 3 wave A): T146 light-only sweep + cross-cutting source audits for every molecule
// folder (BACKLOG-phase3 R1, R2, R3, T146 AC1/AC2; CONTRACTS R-1, R-2).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../../src/components/molecules");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const ALL = walk(ROOT).filter((p) => /\.(tsx?|css)$/.test(p));
const IMPL = ALL.filter((p) => !/\.test\.|test-helpers|_test-utils|\.fixture\./.test(p));
const read = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => relative(ROOT, p);
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function hits(files: string[], re: RegExp, transform: (s: string) => string = (s) => s): string[] {
  const out: string[] = [];
  for (const f of files) {
    transform(read(f))
      .split("\n")
      .forEach((line, i) => {
        if (re.test(line)) out.push(`${rel(f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  return out;
}

describe("R1 / T146 AC1: light only in every molecule source", () => {
  test("sources found", () => {
    expect(IMPL.length).toBeGreaterThan(100);
  });

  test("no dark: utilities, prefers-color-scheme, data-theme or color-scheme dark", () => {
    expect(hits(IMPL, /(^|[\s"'`])dark:|prefers-color-scheme|data-theme|color-scheme:\s*light dark/)).toEqual([]);
  });

  test("no theme toggle copy", () => {
    expect(hits(IMPL, /dark mode|light mode|theme toggle|toggleTheme/i, stripComments)).toEqual([]);
  });
});

describe("R2: brand-free molecule sources", () => {
  test("no retailer or pay-later brand names", () => {
    expect(hits(IMPL, /kmart|onepass|afterpay|zip pay|(^|[^a-z])anko/i)).toEqual([]);
  });

  test("no copied retailer slogans", () => {
    expect(hits(IMPL, /low prices|delivered faster|click & collect/i, stripComments)).toEqual([]);
  });
});

describe("R3: tokens-only Tailwind and type hygiene", () => {
  test("no arbitrary values in class strings (e.g. w-[13px], bg-[...]) and no raw hex colours", () => {
    expect(hits(IMPL, /\b[a-z-]+:?[a-z-]*-\[[^\]]+\]/, stripComments)).toEqual([]);
    expect(hits(IMPL, /\x23[0-9a-fA-F]{3,8}\b/, stripComments).filter((h) => !/href=|#slide|#gallery|`#\$\{/.test(h))).toEqual([]);
  });

  test("no `any`, @ts-ignore, @ts-expect-error, eval or dangerouslySetInnerHTML outside JsonLd", () => {
    const code = hits(IMPL, /:\s*any\b|\bas any\b|<any>|@ts-ignore|@ts-expect-error|\beval\(|new Function\(/, stripComments);
    expect(code).toEqual([]);
    const dsih = hits(IMPL, /dangerouslySetInnerHTML/, stripComments).filter((h) => !h.startsWith("JsonLd/"));
    expect(dsih).toEqual([]);
  });

  test("no committed secrets or credentials", () => {
    expect(hits(ALL, /sk_(live|test)_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]\s*["'][^"']{8,}/i)).toEqual([]);
  });

  test("no outline-none / outline-0 that would hide the focus ring", () => {
    expect(hits(IMPL, /(^|[\s"'`])(focus(-visible)?:)?outline-(none|0)(?=[\s"'`])/, stripComments)).toEqual([]);
  });
});

describe("Phase 3 presentational molecules stay server-safe (no 'use client')", () => {
  const SERVER_SAFE = [
    "CategoryNav/CategoryNav.tsx",
    "BenefitsStrip/BenefitsStrip.tsx",
    "ServiceTiles/ServiceTiles.tsx",
    "ChipRow/ChipRow.tsx",
    "FeedbackBlock/FeedbackBlock.tsx",
    "PromoStrip/PromoStrip.tsx",
    "PromoTile/PromoTile.tsx",
    "LifestyleCard/LifestyleCard.tsx",
    "HeroBanner/HeroBanner.tsx",
    "ProductCard/ProductCard.tsx",
  ];
  for (const f of SERVER_SAFE) {
    test(f, () => {
      expect(read(join(ROOT, f)).trimStart().startsWith('"use client"')).toBe(false);
    });
  }
});

describe("T146 AC2: card surfaces come from the Card atom; chips from the Chip atom", () => {
  for (const f of ["AddressCard/AddressCard.tsx", "OrderCard/OrderCard.tsx", "QuestionCard/QuestionCard.tsx", "ShareListPanel/ShareListPanel.tsx"]) {
    test(`${f} uses Card`, () => {
      const src = read(join(ROOT, f));
      expect(src).toMatch(/from "@\/components\/atoms\/Card"/);
      expect(src).toMatch(/<Card\b/);
    });
  }
  test("ActiveFilters remove chips use the Chip atom", () => {
    const src = read(join(ROOT, "ActiveFilters/ActiveFilters.tsx"));
    expect(src).toMatch(/from "@\/components\/atoms\/Chip"/);
  });
});
