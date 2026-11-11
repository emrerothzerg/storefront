// QA (T01, rewritten for Phase 3 by QA-ATOMS-P3): independent re-verification
// of the LIGHT-ONLY design tokens in src/app/globals.css. Parses the single raw
// :root block, recomputes WCAG 2.x contrast for every pair the comment header
// documents (threshold AND stated ratio), asserts every AA text pair the
// atoms render, and asserts the two documented exceptions (focus ring next to
// solid fills; accent fills on the dark band) AS exceptions: the numbers must
// match, must really be below 3:1, and the documented mitigation must hold.
// No colour value is written in this file; everything is read from globals.css.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BODY,
  HEADER,
  PAIRS_SECTION,
  PALETTE,
  README,
  ROOT,
  ROOT_BLOCK,
  SURFACES,
  fmt,
  parseHeaderRows,
  raw,
  ratio,
} from "./_palette";

const SURF = SURFACES;
const TOL = 0.011; // header prints 2 decimals

/** Phase 2 + Phase 3 role variables: every one must be a raw value in :root. */
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

describe("T01.0 light mode only (Phase 3 R1 / T130 AC1)", () => {
  test("no dark machinery: no prefers-color-scheme, data-theme, .dark, second palette block", () => {
    expect(BODY).not.toMatch(/prefers-color-scheme/);
    expect(BODY).not.toMatch(/data-theme/);
    expect(BODY).not.toMatch(/\.dark\b/);
    // Exactly one block declares --surface-page (the light :root).
    expect(BODY.match(/--surface-page:/g)?.length).toBe(1);
  });

  test("every color-scheme declaration is exactly `light`, and :root opens with it", () => {
    const decls = [...BODY.matchAll(/color-scheme:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(decls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(decls)).toEqual(new Set(["light"]));
    expect(ROOT_BLOCK).toMatch(/^\s*color-scheme:\s*light;/);
  });

  test("the palette parsed (guards against a silent parse failure)", () => {
    expect(Object.keys(PALETTE).length).toBeGreaterThanOrEqual(ROLE_VARS.length);
  });
});

describe("T01.1 @theme token families", () => {
  const theme = BODY.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  test.each([
    ["color", /--color-surface-page:/],
    ["spacing", /--spacing:\s*0\.25rem/],
    ["touch spacing", /--spacing-touch:\s*2\.75rem/],
    ["font-size", /--text-body:/],
    ["line-height", /--text-body--line-height:/],
    ["price type", /--text-price:/],
    ["price type lg", /--text-price-lg:/],
    ["radius", /--radius-md:/],
    ["radius lg (cards)", /--radius-lg:/],
    ["shadow", /--shadow-md:/],
    ["breakpoint", /--breakpoint-md:/],
  ])("%s token defined in @theme inline", (_name, re) => {
    expect(theme).toMatch(re);
  });

  test.each(ROLE_VARS.map((v) => [v]))("--%s is a raw value in the light :root, mapped and documented", (v) => {
    expect(PALETTE[v]).toBeDefined();
    expect(theme).toContain(`--color-${v}: var(--${v});`);
    expect(HEADER).toContain(`--color-${v}`);
  });

  test("default palette, radii, shadows and breakpoints are reset", () => {
    for (const ns of ["color", "radius", "shadow", "breakpoint"]) {
      expect(BODY).toMatch(new RegExp(`--${ns}-\\*:\\s*initial;`));
    }
  });
});

describe("T01.2 documented contrast rows (parsed from the header, recomputed)", () => {
  const rows = parseHeaderRows();

  test("the header parser found the table (>= 25 single-line rows)", () => {
    expect(rows.length).toBeGreaterThanOrEqual(25);
  });

  const cases = rows.flatMap((r) =>
    r.bgs.map((bg, i) => [r.fg, bg, r.stated[i] ?? Number.NaN, r.min ?? 0, r.line] as const),
  );
  test.each(cases.map((c) => [...c]))("%s on %s: stated %d, min %d  [%s]", (fg, bg, stated, min) => {
    expect(PALETTE[fg]).toBeDefined();
    expect(PALETTE[bg]).toBeDefined();
    const r = ratio(fg, bg);
    expect(Math.abs(r - stated)).toBeLessThanOrEqual(TOL);
    expect(r).toBeGreaterThanOrEqual(min);
  });

  test("each row states as many ratios as it names backgrounds", () => {
    for (const r of rows) expect(r.stated.length).toBe(r.bgs.length);
  });
});

describe("T01.2 documented contrast rows (multi-line / table rows, transcribed by name)", () => {
  // Tint table: "<k> text on <k>-subtle | text-primary | focus-ring | border-strong".
  const TINT_ROW = /^\s*(accent|promo|deal|danger|success|warning|info)\s+(\d+\.\d+|-)\s*\|\s*(\d+\.\d+)\s*\|\s*(\d+\.\d+)\s*\|\s*(\d+\.\d+)/;
  const tintRows = PAIRS_SECTION.split("\n")
    .map((l) => l.match(TINT_ROW))
    .filter((m): m is RegExpMatchArray => m !== null);

  test("tint table has all seven tones", () => {
    expect(tintRows.map((m) => m[1]).sort()).toEqual(
      ["accent", "danger", "deal", "info", "promo", "success", "warning"],
    );
  });

  const tintCases = tintRows.flatMap((m) => {
    const k = m[1]!;
    const out: Array<[string, string, number, number]> = [];
    if (m[2] !== "-") out.push([k, `${k}-subtle`, Number(m[2]), 4.5]);
    out.push(["text-primary", `${k}-subtle`, Number(m[3]), 4.5]);
    out.push(["focus-ring", `${k}-subtle`, Number(m[4]), 3]);
    out.push(["border-strong", `${k}-subtle`, Number(m[5]), 3]);
    return out;
  });
  test.each(tintCases)("tint: %s on %s = %d (min %d)", (fg, bg, stated, min) => {
    const r = ratio(fg, bg);
    expect(Math.abs(r - stated)).toBeLessThanOrEqual(TOL);
    expect(r).toBeGreaterThanOrEqual(min);
  });

  test("promo tint: never promo text on its own tint (row states '-')", () => {
    expect(tintRows.find((m) => m[1] === "promo")?.[2]).toBe("-");
  });

  // Rows whose numbers sit on a continuation line or in prose.
  const PROSE: Array<[fg: string, bg: string, min: number, where: RegExp]> = [
    ["text-secondary", "promo-subtle", 4.5, /promo\s+-\s*\|[^\n]*text-secondary\s+(\d+\.\d+)/],
    ["accent", "promo-subtle", 4.5, /promo\s+-\s*\|[^\n]*accent\s+(\d+\.\d+)\)/],
    ["accent", "promo", 3, /accent fill\s+on promo \/ promo-hover[^\n]*\n\s*(\d+\.\d+)/],
    ["accent", "promo-hover", 3, /accent fill\s+on promo \/ promo-hover[^\n]*\n\s*\d+\.\d+\s*\/\s*(\d+\.\d+)/],
    ["accent", "danger-subtle", 4.5, /on danger \/ success \/ warning \/ info-subtle\s*\n\s*(\d+\.\d+)/],
    ["accent", "success-subtle", 4.5, /info-subtle\s*\n\s*\d+\.\d+\s*\/\s*(\d+\.\d+)/],
    ["accent", "warning-subtle", 4.5, /info-subtle\s*\n\s*(?:\d+\.\d+\s*\/\s*){2}(\d+\.\d+)/],
    ["accent", "info-subtle", 4.5, /info-subtle\s*\n\s*(?:\d+\.\d+\s*\/\s*){3}(\d+\.\d+)/],
    ...SURF.map(
      (s, i) =>
        [
          "border-strong",
          s,
          3,
          new RegExp(`DECORATIVE icon colour[\\s\\S]*?sunken\\s*\\n\\s*(?:\\d+\\.\\d+\\s*\\/\\s*){${i}}(\\d+\\.\\d+)`),
        ] as [string, string, number, RegExp],
    ),
  ];
  test.each(PROSE)("prose row: %s on %s (min %d) matches the stated figure", (fg, bg, min, where) => {
    const stated = PAIRS_SECTION.match(where)?.[1];
    expect(stated).toBeDefined();
    const r = ratio(fg, bg);
    expect(Math.abs(r - Number(stated))).toBeLessThanOrEqual(TOL);
    expect(r).toBeGreaterThanOrEqual(min);
  });

  test("text-secondary is documented as NOT usable on promo-hover (and really fails 4.5)", () => {
    expect(PAIRS_SECTION).toMatch(/not on promo-hover:\s*3\.60/);
    const r = ratio("text-secondary", "promo-hover");
    expect(r).toBeLessThan(4.5);
    expect(fmt(r)).toBe("3.60");
  });

  test("scrim: composite over the page and dialog-vs-scrim ratio match the header", async () => {
    const { composite, contrastRgb, hexToRgb, parseScrim, rgbToHex } = await import("./_palette");
    const scrim = parseScrim();
    expect(scrim).not.toBeNull();
    const page = composite(scrim!.rgb, scrim!.alpha, hexToRgb(raw("surface-page")));
    const stated = HEADER.match(/composites to\s+about\s+(\x23[0-9a-fA-F]{6})/)?.[1];
    expect(stated).toBeDefined();
    expect(rgbToHex(page)).toBe(stated!.toLowerCase());
    const dialog = contrastRgb(hexToRgb(raw("surface-raised")), page);
    expect(HEADER).toContain(`dialog vs scrimmed page ${fmt(dialog)}`);
    // The scrim's own colour is text-primary (the near-black neutral).
    expect(hexToRgb(raw("text-primary"))).toEqual(scrim!.rgb);
  });
});

// Every AA text pair the Phase 3 palette must satisfy, written by NAME with
// its WCAG threshold (T130 AC3 + the pairs atoms render). The header must
// state the recomputed figure, so an undocumented pair is caught here.
const AA_TEXT_PAIRS: Array<[fg: string, bg: string, min: number]> = [
  ...SURF.flatMap((s) =>
    ["text-primary", "text-secondary", "accent", "deal", "danger", "success", "warning", "info"].map(
      (fg) => [fg, s, 4.5] as [string, string, number],
    ),
  ),
  ["text-inverse", "surface-inverse", 4.5],
  ["text-on-accent", "accent", 4.5],
  ["text-on-accent", "accent-hover", 4.5],
  ["text-on-accent", "accent-active", 4.5],
  ["text-on-accent", "deal", 4.5],
  ["text-on-accent", "danger", 4.5],
  ["text-on-accent", "danger-hover", 4.5],
  ["text-on-accent", "success", 4.5],
  ["text-on-accent", "success-hover", 4.5],
  ["text-on-accent", "warning", 4.5],
  ["text-on-accent", "info", 4.5],
  ["text-primary", "promo", 4.5],
  ["text-primary", "promo-hover", 4.5],
  ["text-secondary", "promo", 4.5],
  ...["accent", "promo", "deal", "danger", "success", "warning", "info"].map(
    (k) => ["text-primary", `${k}-subtle`, 4.5] as [string, string, number],
  ),
  ...["accent", "deal", "danger", "success", "warning", "info"].map(
    (k) => [k, `${k}-subtle`, 4.5] as [string, string, number],
  ),
  ["text-primary", "border-default", 4.5],
];

describe("T01.2 every AA text pair passes and is documented", () => {
  test.each(AA_TEXT_PAIRS)("%s on %s >= %d:1 and the header/README states the figure", (fg, bg, min) => {
    const r = ratio(fg, bg);
    expect(r).toBeGreaterThanOrEqual(min);
    expect(HEADER + README).toContain(fmt(r));
  });
});

describe("T130 AC3 thresholds as written", () => {
  test("body text on canvas >= 7:1", () => {
    for (const s of SURF) expect(ratio("text-primary", s)).toBeGreaterThanOrEqual(7);
  });
  test("primary-on-white text >= 4.5 and on-primary on primary (all states) >= 4.5", () => {
    expect(ratio("accent", "surface-page")).toBeGreaterThanOrEqual(4.5);
    for (const f of ["accent", "accent-hover", "accent-active"]) {
      expect(ratio("text-on-accent", f)).toBeGreaterThanOrEqual(4.5);
    }
  });
  test("focus ring against canvas >= 3:1", () => {
    for (const s of SURF) expect(ratio("focus-ring", s)).toBeGreaterThanOrEqual(3);
  });
  // D-T130-3 ACCEPTED BY RULING (STATE.md "Rulings on QA-ATOMS-P3", AC3 amended): the ring is drawn with
  // a 2px offset, so its neighbouring colour is the surface around the control, never the control's own
  // accent fill. The ring-vs-fill ratio is a documented exception; what must hold is the offset rule and
  // >= 3:1 against every surface (checked above) and the inverse ring on dark bands.
  test("accepted exception: ring vs accent fill is below 3:1 but the ring is offset 2px onto the surface", () => {
    expect(ratio("focus-ring", "accent")).toBeLessThan(3); // the documented exception, still true
    const css = BODY.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
    expect(rule).toMatch(/outline-offset:\s*2px/);
    expect(css).toMatch(/\.bg-surface-inverse :focus-visible\s*\{[^}]*outline-color:\s*var\(--focus-ring-inverse\)/);
    expect(ratio("focus-ring-inverse", "surface-inverse")).toBeGreaterThanOrEqual(3);
  });
  // D-T130-2 FIXED (designer addendum, README AC5 mapping table; verified by T147). Was PIN: T130 AC5 names nine tokens (radius-card, radius-pill,
  // band-primary, band-primary-subtle, band-neutral, price-sale, badge-sale,
  // badge-new, badge-top). None exists in globals.css and the atoms README has
  // no migration table mapping them (AC2) to the roles used instead (promo,
  // deal, rounded-lg / rounded-full, surface-sunken ...). Flip when added or
  // when the AC is amended to the shipped role names.
  test("D-T130-2 fixed: the atoms README has the 'Backlog token names (T130 AC5) → shipped roles' table listing all nine names", () => {
    const AC5 = ["radius-card", "radius-pill", "band-primary", "band-primary-subtle", "band-neutral",
      "price-sale", "badge-sale", "badge-new", "badge-top"];
    const section = README.split(/^### /m).find((part) => part.startsWith("Backlog token names (T130 AC5)")) ?? "";
    expect(section === "" ? "missing" : "present").toBe("present");
    const rows = section.split("\n").filter((l) => /^\| `[a-z-]+` \|/.test(l)).map((l) => /^\| `([a-z-]+)`/.exec(l)?.[1]);
    expect(rows).toEqual(AC5);
  });
  test("T130 AC5: the named tokens exist, or the README maps each one", () => {
    const AC5 = ["radius-card", "radius-pill", "band-primary", "band-primary-subtle", "band-neutral",
      "price-sale", "badge-sale", "badge-new", "badge-top"];
    const missing = AC5.filter((t) => !BODY.includes(`--${t}`) && !BODY.includes(`--color-${t}`) && !README.includes(`\`${t}\``));
    expect(missing).toEqual([]);
  });
  test("border-strong >= 3:1 against canvas", () => {
    for (const s of SURF) expect(ratio("border-strong", s)).toBeGreaterThanOrEqual(3);
  });
  test("danger/success text on their subtle fills >= 4.5:1", () => {
    expect(ratio("danger", "danger-subtle")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("success", "success-subtle")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("documented exception 1: focus ring next to solid fills (not verified, by design)", () => {
  const para = PAIRS_SECTION.match(/NOT verified, by design[\s\S]*?\.\s*\n/)?.[0] ?? "";
  const listed = [...para.replace(/\n\s*/g, " ").matchAll(/(?:solid )?([a-z]+(?:-[a-z]+)?) (\d+\.\d+)/g)]
    .map((m) => [m[1]!, Number(m[2])] as const)
    .filter(([name]) => PALETTE[name] !== undefined);
  const EXPECTED = ["accent", "accent-hover", "accent-active", "promo-hover", "deal", "danger", "success"];

  test("the header lists exactly the expected solid fills", () => {
    expect(para).toContain("ring sits 2px OUTSIDE the control");
    expect(listed.map(([n]) => n).sort()).toEqual([...EXPECTED].sort());
  });

  test.each(EXPECTED.map((n) => [n]))("focus-ring vs %s: stated figure is accurate AND below 3 (a real exception)", (fill) => {
    const stated = listed.find(([n]) => n === fill)?.[1];
    expect(stated).toBeDefined();
    const r = ratio("focus-ring", fill);
    expect(Math.abs(r - stated!)).toBeLessThanOrEqual(TOL);
    expect(r).toBeLessThan(3);
  });

  test("mitigation 1: the base ring is drawn 2px outside every control", () => {
    expect(BODY).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus-ring\);\s*outline-offset:\s*2px;/);
  });

  test("mitigation 2: the ring is >= 3:1 against every surface/tint a control can sit on", () => {
    const neighbours = [...SURF, "accent-subtle", "promo-subtle", "deal-subtle", "danger-subtle",
      "success-subtle", "warning-subtle", "info-subtle", "promo"];
    for (const bg of neighbours) expect(ratio("focus-ring", bg)).toBeGreaterThanOrEqual(3);
  });

  test("mitigation 3: no atom pulls the ring onto its fill (outline-offset-0 next to a solid fill)", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (/outline-offset-0/.test(line) &&
              /\bbg-(accent|accent-hover|accent-active|promo-hover|deal|danger|success|warning|info)\b/.test(line)) {
              offenders.push(`${p}:${i + 1}`);
            }
          });
        }
      }
    };
    walk(join(ROOT, "src/components/atoms"));
    expect(offenders).toEqual([]);
  });

  test("README states the same rule", () => {
    expect(README).toMatch(/not \(and need not be\) 3:1 against solid fills/);
    expect(README).toContain("Never use `focus-visible:outline-offset-0` on a solid fill");
  });
});

describe("documented exception 2: blue (accent) fills on the dark band", () => {
  // Prose wraps across lines in the header; compare with whitespace collapsed.
  const FLAT = PAIRS_SECTION.replace(/\s+/g, " ");
  const fails = PAIRS_SECTION.match(
    /accent \/ hover \/ active vs surface-inverse\s+(\d+\.\d+)\s*\/\s*(\d+\.\d+)\s*\/\s*(\d+\.\d+)\s+3\s+FAILS/,
  );

  test("the header marks the pair as FAILS with the stated figures", () => {
    expect(fails).not.toBeNull();
  });

  test.each([["accent", 1], ["accent-hover", 2], ["accent-active", 3]] as const)(
    "%s vs surface-inverse: stated figure accurate AND below 3 (a real failure, not silently accepted)",
    (fill, idx) => {
      const r = ratio(fill, "surface-inverse");
      expect(Math.abs(r - Number(fails?.[idx]))).toBeLessThanOrEqual(TOL);
      expect(r).toBeLessThan(3);
    },
  );

  test("the label on the fill stays legible: text-on-accent vs inverse as stated", () => {
    const r = ratio("text-on-accent", "surface-inverse");
    expect(FLAT).toContain(`text-on-accent vs inverse ${fmt(r)}`);
    expect(r).toBeGreaterThanOrEqual(4.5);
  });

  test("remedy A (inverse white pill): surface-raised fill vs surface-inverse >= 3 and as stated", () => {
    const r = ratio("surface-raised", "surface-inverse");
    expect(r).toBeGreaterThanOrEqual(3);
    expect(FLAT).toContain(`white pill: ${fmt(r)} vs the band`);
  });

  test("remedy B (ring-2 ring-text-inverse): ring vs band and vs every accent state >= 3, as stated", () => {
    const vsBand = ratio("text-inverse", "surface-inverse");
    expect(FLAT).toContain(`Ring vs inverse ${fmt(vsBand)}`);
    const states = ["accent", "accent-hover", "accent-active"].map((f) => ratio("text-inverse", f));
    for (const r of [vsBand, ...states]) expect(r).toBeGreaterThanOrEqual(3);
    expect(FLAT).toContain(`ring vs accent / hover / active ${states.map(fmt).join(" / ")}`);
    expect(BODY).toMatch(/--color-text-inverse:\s*var\(--text-inverse\)/);
  });

  test("remedies are real API: Button and Link expose an `inverse` look built on the white surface", () => {
    const classes = readFileSync(join(ROOT, "src/components/atoms/Button/button-classes.ts"), "utf8");
    expect(classes).toMatch(/inverse:\s*\n?\s*"[^"]*\bbg-surface-raised\b[^"]*\btext-text-primary\b/);
    const link = readFileSync(join(ROOT, "src/components/atoms/Link/Link.tsx"), "utf8");
    expect(link).toMatch(/LinkButtonVariant\s*=[^;]*"inverse"/);
  });

  test("README documents it as failing, with the remedy", () => {
    expect(README).toMatch(/accent fill \| surface-inverse[^\n]*fails: use `inverse` buttons or `ring-2 ring-text-inverse`/);
  });

  test("on the dark band the blue focus ring passes (3.43 documented) but the base layer swaps to the white ring", () => {
    expect(ratio("focus-ring", "surface-inverse")).toBeGreaterThanOrEqual(3);
    expect(ratio("focus-ring-inverse", "surface-inverse")).toBeGreaterThan(ratio("focus-ring", "surface-inverse"));
    expect(BODY).toMatch(/\.bg-surface-inverse :focus-visible\s*\{\s*outline-color:\s*var\(--focus-ring-inverse\);/);
  });
});

// Pairs the header does not list. Reported, not asserted, unless an atom
// renders them adjacently (see ATOM_PAIRS below).
function undocumentedPairs(): Array<[string, string, number]> {
  const out: Array<[string, string, number]> = [];
  const statuses = ["danger", "success", "warning", "info"];
  for (const s of SURF) {
    out.push(["text-inverse", s, 4.5], ["text-on-accent", s, 4.5], ["border-default", s, 3], ["promo", s, 3]);
  }
  for (const k of statuses) {
    out.push(["text-secondary", `${k}-subtle`, 4.5], ["focus-ring", k, 3]);
    for (const k2 of statuses) if (k2 !== k) out.push([k, `${k2}-subtle`, 4.5]);
  }
  out.push(
    ["text-secondary", "accent-subtle", 4.5],
    ["text-secondary", "deal-subtle", 4.5],
    ["text-secondary", "surface-inverse", 4.5],
    ["deal", "surface-inverse", 4.5],
    ["text-inverse", "promo", 4.5],
  );
  return out;
}

describe("T01.2 undocumented pairs (report only)", () => {
  test("list undocumented pairs below threshold", () => {
    const failing: string[] = [];
    for (const [fg, bg, min] of undocumentedPairs()) {
      const r = ratio(fg, bg);
      if (r < min) failing.push(`${fg} on ${bg} = ${fmt(r)} (< ${min})`);
    }
    console.info(`[tokens.qa] undocumented pairs below threshold:\n  ${failing.join("\n  ")}`);
    expect(failing.every((line) => line.includes(" on "))).toBe(true);
  });
});

// Pairs an atom actually renders adjacently (Phase 3 class tables). Any failure
// here is a defect. Source of truth: class lists in src/components/atoms/**.
const ATOM_PAIRS: Array<[atom: string, fg: string, bg: string, min: number]> = [
  ["Button primary", "text-on-accent", "accent", 4.5],
  ["Button primary hover", "text-on-accent", "accent-hover", 4.5],
  ["Button primary active", "text-on-accent", "accent-active", 4.5],
  ["Button primary on gold band (fill boundary)", "accent", "promo", 3],
  ["Button secondary", "text-primary", "surface-raised", 4.5],
  ["Button secondary border", "border-strong", "surface-page", 3],
  ["Button secondary border on sunken band", "border-strong", "surface-sunken", 3],
  ["Button secondary hover", "text-primary", "accent-subtle", 4.5],
  ["Button outline text", "accent", "surface-raised", 4.5],
  ["Button outline border on page", "accent", "surface-page", 3],
  ["Button outline border on sunken band", "accent", "surface-sunken", 3],
  ["Button outline hover", "accent", "accent-subtle", 4.5],
  ["Button inverse text", "text-primary", "surface-raised", 4.5],
  ["Button inverse hover", "text-primary", "surface-sunken", 4.5],
  ["Button inverse fill on dark band", "surface-raised", "surface-inverse", 3],
  ["Button inverse hover fill on dark band", "surface-sunken", "surface-inverse", 3],
  ["Button ghost", "accent", "surface-page", 4.5],
  ["Button ghost hover", "accent", "accent-subtle", 4.5],
  ["Button danger", "text-on-accent", "danger", 4.5],
  ["Button danger hover", "text-on-accent", "danger-hover", 4.5],
  ["Button quick-add pill", "text-on-accent", "accent", 4.5],
  ["Button quick-add pill hover", "text-on-accent", "accent-hover", 4.5],
  ["Button quick-add pill active", "text-on-accent", "accent-active", 4.5],
  ["Badge subtle neutral", "text-primary", "surface-sunken", 4.5],
  ["Badge subtle success", "success", "success-subtle", 4.5],
  ["Badge subtle warning", "warning", "warning-subtle", 4.5],
  ["Badge subtle danger", "danger", "danger-subtle", 4.5],
  ["Badge subtle info", "info", "info-subtle", 4.5],
  ["Badge subtle accent", "accent", "accent-subtle", 4.5],
  ["Badge subtle promo", "text-primary", "promo-subtle", 4.5],
  ["Badge subtle deal", "deal", "deal-subtle", 4.5],
  ["Badge solid neutral", "text-inverse", "surface-inverse", 4.5],
  ["Badge solid success", "text-on-accent", "success", 4.5],
  ["Badge solid warning", "text-on-accent", "warning", 4.5],
  ["Badge solid danger", "text-on-accent", "danger", 4.5],
  ["Badge solid info", "text-on-accent", "info", 4.5],
  ["Badge solid accent", "text-on-accent", "accent", 4.5],
  ["Badge solid promo", "text-primary", "promo", 4.5],
  ["Badge solid deal", "text-on-accent", "deal", 4.5],
  ["Card raised", "text-primary", "surface-raised", 4.5],
  ["Card sunken", "text-primary", "surface-sunken", 4.5],
  ["Card accent-subtle", "text-primary", "accent-subtle", 4.5],
  ["Card promo-subtle", "text-primary", "promo-subtle", 4.5],
  ["Card deal-subtle", "text-primary", "deal-subtle", 4.5],
  ["Card promo", "text-primary", "promo", 4.5],
  ["Card inverse", "text-inverse", "surface-inverse", 4.5],
  ["Card promo: focus ring (blue kept)", "focus-ring", "promo", 3],
  ["Card inverse: focus ring (white)", "focus-ring-inverse", "surface-inverse", 3],
  ["CategoryTile label", "text-primary", "surface-page", 4.5],
  ["CategoryTile label on sunken band", "text-primary", "surface-sunken", 4.5],
  ["Chip outline", "text-primary", "surface-raised", 4.5],
  ["Chip outline border", "border-strong", "surface-page", 3],
  ["Chip outline hover", "text-primary", "surface-sunken", 4.5],
  ["Chip filled", "text-primary", "surface-sunken", 4.5],
  ["Chip filled hover", "text-primary", "border-default", 4.5],
  ["Chip selected", "accent", "accent-subtle", 4.5],
  ["Chip selected border", "accent", "surface-page", 3],
  ["Input text", "text-primary", "surface-raised", 4.5],
  ["Input placeholder", "text-secondary", "surface-raised", 4.5],
  ["Input disabled", "text-secondary", "surface-sunken", 4.5],
  ["Input border", "border-strong", "surface-raised", 3],
  ["Input invalid border", "danger", "surface-raised", 3],
  ["Input pill text", "text-primary", "surface-sunken", 4.5],
  ["Input pill placeholder", "text-secondary", "surface-sunken", 4.5],
  ["Input pill border vs its fill", "border-strong", "surface-sunken", 3],
  ["Input pill border vs page", "border-strong", "surface-page", 3],
  ["Input pill invalid border", "danger", "surface-sunken", 3],
  ["Input pill focus ring", "focus-ring", "surface-page", 3],
  ["FormField error", "danger", "surface-page", 4.5],
  ["FormField hint", "text-secondary", "surface-page", 4.5],
  ["Price current", "text-primary", "surface-page", 4.5],
  ["Price deal tone", "deal", "surface-page", 4.5],
  ["Price deal tone on card", "deal", "surface-raised", 4.5],
  ["Price deal tone on sunken", "deal", "surface-sunken", 4.5],
  ["Price compare-at", "text-secondary", "surface-page", 4.5],
  ["Rating stars (graphic)", "rating", "surface-page", 3],
  ["Rating stars on sunken (graphic)", "rating", "surface-sunken", 3],
  ["Rating compact value", "text-primary", "surface-raised", 4.5],
  ["Rating count", "text-secondary", "surface-raised", 4.5],
  ["Link inline", "accent", "surface-page", 4.5],
  ["Link subtle", "text-secondary", "surface-page", 4.5],
  ["Link inverse tone", "text-inverse", "surface-inverse", 4.5],
  ["Image placeholder icon", "text-secondary", "surface-sunken", 3],
  ["Stepper pill text", "text-primary", "surface-raised", 4.5],
  ["Stepper pill border", "border-strong", "surface-page", 3],
  ["Stepper hover", "text-primary", "surface-sunken", 4.5],
  ["Stepper disabled icon", "text-secondary", "surface-raised", 3],
  ["SearchField pill submit icon", "text-on-accent", "accent", 4.5],
  ["SearchField pill clear icon", "text-secondary", "surface-sunken", 3],
  ["Focus ring on page", "focus-ring", "surface-page", 3],
  ["Focus ring on raised", "focus-ring", "surface-raised", 3],
  ["Focus ring on sunken", "focus-ring", "surface-sunken", 3],
];

describe("T01.2 pairs used by atoms (Phase 3)", () => {
  test.each(ATOM_PAIRS.map((p) => [...p]))("%s (%s on %s) >= %d:1", (_atom, fg, bg, min) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});

describe("T01.3 / T01.4 base layer", () => {
  test(":focus-visible draws a 2px solid focus-ring outline with offset", () => {
    expect(BODY).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus-ring\);\s*outline-offset:\s*2px;/);
  });

  test("inside .bg-surface-inverse the ring switches to the white inverse ring; promo keeps blue", () => {
    expect(BODY).toMatch(/\.bg-surface-inverse :focus-visible\s*\{\s*outline-color:\s*var\(--focus-ring-inverse\);\s*\}/);
    expect(BODY).not.toMatch(/\.bg-promo[^{]*:focus-visible/);
  });

  test("focus ring is >= 3:1 against every surface, tint and the gold band it can sit on", () => {
    const bgs = [...SURF, "surface-inverse", "accent-subtle", "promo", "promo-subtle", "deal-subtle",
      "danger-subtle", "success-subtle", "warning-subtle", "info-subtle"];
    for (const bg of bgs) expect(ratio("focus-ring", bg)).toBeGreaterThanOrEqual(3);
  });

  test("prefers-reduced-motion block cuts animation and transition", () => {
    const m = BODY.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n  \}/);
    expect(m).not.toBeNull();
    const block = m?.[1] ?? "";
    expect(block).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(block).toMatch(/animation-iteration-count:\s*1 !important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms !important/);
  });
});

describe("T01.5 check:tokens", () => {
  test("bun run check:tokens exits 0", () => {
    const r = Bun.spawnSync(["sh", "scripts/check-tailwind-tokens.sh"], { cwd: ROOT });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("check:tokens: OK");
  });

  test("check:tokens actually catches violations (self-test on a temp tree)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "qa-tokens-"));
    try {
      mkdirSync(join(tmp, "scripts"));
      mkdirSync(join(tmp, "src/components"), { recursive: true });
      writeFileSync(
        join(tmp, "scripts/check-tailwind-tokens.sh"),
        readFileSync(join(ROOT, "scripts/check-tailwind-tokens.sh")),
      );
      // Seeded violations; the hex literals are assembled so this file holds none.
      const H = String.fromCharCode(35);
      writeFileSync(
        join(tmp, "src/components/Bad.tsx"),
        [
          `const a = "bg-[${H}fff] p-[13px]";`,
          `const b = "${H}${"1c1917"}";`,
          'const c = "bg-gray-100 text-white";',
          'const d = "rounded-2xl shadow-xl";',
          "",
        ].join("\n"),
      );
      const r = Bun.spawnSync(["sh", join(tmp, "scripts/check-tailwind-tokens.sh")], { cwd: ROOT });
      const out = r.stdout.toString();
      expect(r.exitCode).toBe(1);
      expect(out).toContain("arbitrary values");
      expect(out).toContain("raw hex");
      expect(out).toContain("default palette");
      expect(out).toContain("rounded-xs/2xl");
      expect(out).toContain("shadow-xs/xl");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
