// QA (QA-W0-D1, criterion 13; rewritten light-only by QA-ATOMS-P3): independent
// re-computation of the contrast ratios P2-D1 documented for the Phase 2 token
// pairs, now against the single LIGHT palette (Phase 3 removed the dark theme),
// from the raw values in src/app/globals.css. Also: no MVP token removed or
// renamed, Phase 2 tokens wired through @theme inline, scrim/skeleton/summary
// marker present, and `bun run check:tokens` passes. No colour value is
// written here: stated figures are checked by looking the recomputed ratio up
// in the header (transcription guard), not by hard-coding them.
import { describe, expect, test } from "bun:test";
import {
  BODY,
  HEADER,
  PALETTE,
  README,
  ROOT,
  SURFACES as SURF,
  composite,
  contrastRgb,
  fmt,
  hexToRgb,
  parseHeaderRows,
  parseScrim,
  raw,
  ratio,
  rgbToHex,
} from "./_palette";

// [fg, bg, minimum (0 = documented as n/a / below 3 by design)]
type Pair = readonly [string, string, number];
const NEW_PAIRS: Pair[] = [
  ["text-on-accent", "danger-hover", 4.5],
  ["text-on-accent", "success-hover", 4.5],
  ...SURF.map((s) => ["rating", s, 3] as const),
  ["surface-raised", "border-strong", 3],
  ["accent", "danger-subtle", 4.5],
  ["accent", "success-subtle", 4.5],
  ["accent", "warning-subtle", 4.5],
  ["accent", "info-subtle", 4.5],
  ...SURF.map((s) => ["skeleton", s, 0] as const),
];

describe("criterion 13: Phase 2 token pairs recomputed (light only)", () => {
  test.each(NEW_PAIRS.map((p) => [...p]))("%s on %s (min %d): meets the minimum and the header states it", (fg, bg, min) => {
    const r = ratio(fg, bg);
    if (min > 0) expect(r).toBeGreaterThanOrEqual(min);
    // transcription guard: the recomputed figure is the one documented
    expect(HEADER).toContain(fmt(r));
  });

  test("skeleton row is documented as n/a (decorative) with the recomputed figures", () => {
    const row = parseHeaderRows().find((r) => r.fg === "skeleton");
    expect(row).toBeDefined();
    expect(row!.min).toBeNull();
    expect(row!.bgs).toEqual([...SURF]);
    row!.bgs.forEach((bg, i) => expect(Math.abs(ratio("skeleton", bg) - row!.stated[i]!)).toBeLessThanOrEqual(0.011));
  });

  test("focus ring next to the danger/success HOVER fills is below 3:1 (covered only by the 2px-offset rule)", () => {
    // Phase 2 documented these as "n/a, below 3 by design". Phase 3 keeps the
    // same reasoning (ring on the surface, not the fill) via the base offset.
    for (const fill of ["danger-hover", "success-hover"]) expect(ratio("focus-ring", fill)).toBeLessThan(3);
    expect(BODY).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus-ring\);\s*outline-offset:\s*2px;/);
    expect(HEADER).toContain("ring sits 2px OUTSIDE the control");
  });

  test("rating also meets 4.5 on every surface (header claim 'also >= 4.5')", () => {
    expect(HEADER).toMatch(/also >= 4\.5/);
    for (const s of SURF) expect(ratio("rating", s)).toBeGreaterThanOrEqual(4.5);
  });

  test("scrim composites as documented: page under the scrim and dialog-vs-scrimmed-page ratio", () => {
    const scrim = parseScrim();
    expect(scrim).not.toBeNull();
    const page = composite(scrim!.rgb, scrim!.alpha, hexToRgb(raw("surface-page")));
    const stated = HEADER.match(/composites to\s+about\s+(\x23[0-9a-fA-F]{6})/)?.[1];
    expect(stated).toBeDefined();
    expect(rgbToHex(page)).toBe(stated!.toLowerCase());
    const dialog = contrastRgb(hexToRgb(raw("surface-raised")), page);
    expect(HEADER).toContain(`dialog vs scrimmed page ${fmt(dialog)}`);
    // Light only: there is no second (dark) scrim to composite.
    expect(BODY.match(/--scrim:/g)?.length).toBe(1);
  });
});

describe("criterion 13: token inventory", () => {
  const MVP_RAW = [
    "surface-page", "surface-raised", "surface-sunken", "surface-inverse",
    "text-primary", "text-secondary", "text-inverse", "text-on-accent",
    "border-default", "border-strong", "accent", "accent-hover", "accent-active", "accent-subtle",
    "danger", "danger-subtle", "success", "success-subtle", "warning", "warning-subtle",
    "info", "info-subtle", "focus-ring",
  ];
  const NEW_RAW = ["danger-hover", "success-hover", "rating", "skeleton"];

  test.each([...MVP_RAW, ...NEW_RAW].map((v) => [v]))("--%s defined once, in the light :root, and mapped to --color-*", (v) => {
    expect(PALETTE[v]).toBeDefined();
    // Light only: exactly one raw declaration (no dark override block).
    expect(BODY.match(new RegExp(`--${v}:`, "g"))?.length).toBe(1);
    expect(BODY).toContain(`--color-${v}: var(--${v});`);
  });

  test("--scrim defined once for :root and ::backdrop (dark, semi-opaque), mapped to --color-scrim", () => {
    const scrim = parseScrim();
    expect(scrim).not.toBeNull();
    // Darkens what is behind it: the scrim colour is the near-black text neutral.
    expect(scrim!.rgb).toEqual(hexToRgb(raw("text-primary")));
    expect(scrim!.alpha).toBeGreaterThan(0);
    expect(scrim!.alpha).toBeLessThan(1);
    expect(BODY).not.toMatch(/prefers-color-scheme/);
    expect(BODY).toContain("--color-scrim: var(--scrim);");
  });

  test("summary::-webkit-details-marker base rule present", () => {
    expect(BODY).toMatch(/summary::-webkit-details-marker\s*\{\s*display:\s*none;/);
  });

  test("every colour utility named in the README role table maps to a defined --color-* token", () => {
    const table = README.split("### Which utility for which role")[1]?.split("Only the text/surface pairs")[0] ?? "";
    const utils = [...table.matchAll(/(?:^|[\s`:])(?:bg|text|border|divide)-((?:surface|text|border|accent|danger|success|warning|info|rating|skeleton|scrim)[a-z-]*)/g)].map((m) => m[1]!);
    expect(utils.length).toBeGreaterThan(15);
    for (const u of new Set(utils)) expect(BODY).toContain(`--color-${u}:`);
  });

  test("README also lists bg-scrim and bg-skeleton (inventory)", () => {
    expect(README).toContain("bg-skeleton");
    expect(README).toContain("bg-scrim");
  });
});

describe("criterion 13: check:tokens", () => {
  test("bun run check:tokens exits 0", () => {
    const r = Bun.spawnSync(["sh", "scripts/check-tailwind-tokens.sh"], { cwd: ROOT });
    expect(r.stdout.toString()).toContain("check:tokens: OK");
    expect(r.exitCode).toBe(0);
  });
});
