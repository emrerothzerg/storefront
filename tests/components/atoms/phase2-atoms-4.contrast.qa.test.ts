// QA (QA-ATOMS-4, item 8; rewritten light-only by QA-ATOMS-P3): independent
// re-computation of the inverse-band and text-border-strong contrast figures
// documented in the src/app/globals.css header, from the raw token values
// parsed out of the file. Phase 3 has ONE (light) palette; the figures are
// recomputed here and looked up in the header rather than hard-coded, so the
// test follows palette changes but fails on any header/value mismatch.
import { describe, expect, test } from "bun:test";
import { BODY, HEADER, PAIRS_SECTION, PALETTE, SURFACES, fmt, ratio } from "./_palette";

// Header prose wraps across lines; compare with whitespace collapsed.
const FLAT = PAIRS_SECTION.replace(/\s+/g, " ");

// ring = text-inverse (the `ring-2 ring-text-inverse` remedy); the base
// layer's white focus ring is focus-ring-inverse.
interface Claim {
  name: string;
  a: string;
  b: string;
  /** Minimum, or "below3" for the fills the header documents as failing. */
  min: number | "below3";
}
const CLAIMS: Claim[] = [
  { name: "accent fill vs surface-inverse", a: "accent", b: "surface-inverse", min: "below3" },
  { name: "accent-hover fill vs surface-inverse", a: "accent-hover", b: "surface-inverse", min: "below3" },
  { name: "accent-active fill vs surface-inverse", a: "accent-active", b: "surface-inverse", min: "below3" },
  { name: "text-on-accent vs surface-inverse", a: "text-on-accent", b: "surface-inverse", min: 4.5 },
  { name: "ring (text-inverse) vs surface-inverse", a: "text-inverse", b: "surface-inverse", min: 3 },
  { name: "ring (text-inverse) vs accent", a: "text-inverse", b: "accent", min: 3 },
  { name: "ring (text-inverse) vs accent-hover", a: "text-inverse", b: "accent-hover", min: 3 },
  { name: "ring (text-inverse) vs accent-active", a: "text-inverse", b: "accent-active", min: 3 },
  { name: "focus-ring vs surface-inverse", a: "focus-ring", b: "surface-inverse", min: 3 },
  { name: "focus-ring-inverse vs surface-inverse", a: "focus-ring-inverse", b: "surface-inverse", min: 3 },
  { name: "text-border-strong vs surface-page", a: "border-strong", b: "surface-page", min: 3 },
  { name: "text-border-strong vs surface-raised", a: "border-strong", b: "surface-raised", min: 3 },
  { name: "text-border-strong vs surface-sunken", a: "border-strong", b: "surface-sunken", min: 3 },
];

describe("item 8: inverse-band contrast claims match the tokens (light only)", () => {
  test("the single palette parsed with every token used below", () => {
    for (const c of CLAIMS) {
      expect(PALETTE[c.a]).toMatch(/^\x23/);
      expect(PALETTE[c.b]).toMatch(/^\x23/);
    }
  });

  for (const c of CLAIMS) {
    test(`${c.name}: header states the recomputed figure${c.min === "below3" ? " and it is below 3:1" : ` and >= ${c.min}:1`}`, () => {
      const r = ratio(c.a, c.b);
      expect(HEADER).toContain(fmt(r));
      if (c.min === "below3") expect(r).toBeLessThan(3);
      else expect(r).toBeGreaterThanOrEqual(c.min);
    });
  }

  test("the accent fills really are below 3:1 on surface-inverse (why the remedy exists)", () => {
    for (const fill of ["accent", "accent-hover", "accent-active"]) {
      expect(ratio(fill, "surface-inverse")).toBeLessThan(3);
    }
  });

  test("rejected alternative: a border-strong ring would not fix it (below 3 against the band or the fill)", () => {
    // Phase 2 documented border-strong as a rejected ring colour. Phase 3's
    // header only lists the accepted remedies; check the rejection still holds.
    const vsBand = ratio("border-strong", "surface-inverse");
    const vsFill = ratio("border-strong", "accent");
    expect(Math.min(vsBand, vsFill)).toBeLessThan(3);
    expect(FLAT).not.toMatch(/ring-2 ring-border-strong/);
  });

  test("header documents the figures (in order) and the remedies: `inverse` pill and `ring-2 ring-text-inverse`", () => {
    const fills = ["accent", "accent-hover", "accent-active"].map((f) => fmt(ratio(f, "surface-inverse")));
    expect(FLAT).toMatch(new RegExp(`accent / hover / active vs surface-inverse ${fills.join(" / ")} 3 FAILS`));
    const ring = ["accent", "accent-hover", "accent-active"].map((f) => fmt(ratio("text-inverse", f)));
    expect(FLAT).toContain(`ring vs accent / hover / active ${ring.join(" / ")}`);
    expect(FLAT).toContain(`Ring vs inverse ${fmt(ratio("text-inverse", "surface-inverse"))}`);
    expect(FLAT).toContain(`text-on-accent vs inverse ${fmt(ratio("text-on-accent", "surface-inverse"))}`);
    expect(FLAT).toContain("ring-2 ring-text-inverse");
    expect(FLAT).toContain("Button / Link `inverse`");
    const strong = SURFACES.map((s) => fmt(ratio("border-strong", s)));
    expect(FLAT).toMatch(new RegExp(`DECORATIVE icon colour .*? on surface-page / raised / sunken ${strong.join(" / ")} 3`));
    expect(FLAT).toContain(`focus-ring on surface-inverse ${fmt(ratio("focus-ring", "surface-inverse"))} 3`);
  });

  test("ring-text-inverse resolves: --color-text-inverse is wired in @theme inline", () => {
    expect(BODY).toMatch(/--color-text-inverse:\s*var\(--text-inverse\)/);
  });
});
