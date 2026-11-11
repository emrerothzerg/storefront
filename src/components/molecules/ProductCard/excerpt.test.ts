import { describe, expect, test } from "bun:test";
import { EXCERPT_MAX, excerpt } from "./excerpt";

const ELLIPSIS = "…";

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("excerpt", () => {
  test("default max is 160", () => {
    expect(EXCERPT_MAX).toBe(160);
  });

  test("short text is returned unchanged (no ellipsis)", () => {
    expect(excerpt("A sturdy tote.")).toBe("A sturdy tote.");
  });

  test("text exactly at the limit is not truncated", () => {
    const text = "x".repeat(160);
    expect(excerpt(text)).toBe(text);
    expect(excerpt(text)).not.toContain(ELLIPSIS);
  });

  test("long text is cut to <= max including the ellipsis, on a word break", () => {
    const text = "Lorem ipsum dolor sit amet ".repeat(20);
    const out = excerpt(text);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith(ELLIPSIS)).toBe(true);
    expect(out).not.toMatch(/\s…$/);
    expect(text.startsWith(out.slice(0, -1))).toBe(true);
    expect(out.slice(0, -1).endsWith("sit") || /\w$/.test(out.slice(0, -1))).toBe(true);
  });

  test("unbroken text is hard-cut to max", () => {
    const out = excerpt("y".repeat(500));
    expect(out).toBe(`${"y".repeat(159)}${ELLIPSIS}`);
  });

  test("never cuts in the middle of a surrogate pair", () => {
    for (let pad = 0; pad < 4; pad += 1) {
      const text = "a".repeat(pad) + "\u{1F600}".repeat(200);
      const out = excerpt(text, 20);
      expect(hasLoneSurrogate(out)).toBe(false);
      expect(out.length).toBeLessThanOrEqual(20);
      expect(out.endsWith(ELLIPSIS)).toBe(true);
    }
  });

  test("does not split a ZWJ emoji sequence", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // 8 code units
    const out = excerpt(`${"b".repeat(5)}${family}${"c".repeat(50)}`, 10);
    // 9 units of budget: "bbbbb" (5) + family (8) does not fit, so the family is dropped whole.
    expect(out).toBe(`bbbbb${ELLIPSIS}`);
  });

  test("collapses whitespace and trims", () => {
    expect(excerpt("  a\n\n b\t c  ")).toBe("a b c");
  });

  test("hostile markup stays plain text", () => {
    expect(excerpt("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });

  test("non-string input yields empty string; invalid max falls back to 160", () => {
    expect(excerpt(undefined as unknown as string)).toBe("");
    expect(excerpt("z".repeat(200), Number.NaN).length).toBe(160);
    expect(excerpt("z".repeat(200), 1).length).toBe(160);
    expect(excerpt("z".repeat(200), 2.5).length).toBe(160);
  });

  test("trailing punctuation before the ellipsis is dropped", () => {
    const out = excerpt(`${"word ".repeat(10)}end, more words here`, 54);
    expect(out.endsWith(`,${ELLIPSIS}`)).toBe(false);
  });
});
