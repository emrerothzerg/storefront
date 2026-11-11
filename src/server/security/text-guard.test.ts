import { describe, expect, test } from "bun:test";
import type { AppError, Result } from "@/lib/result";
import { cleanText, countUrls, normalizeCouponCode } from "./text-guard";

function value(r: Result<string, AppError>): string {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function code(r: Result<string, AppError>): string {
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r.value)}`);
  return r.error.code;
}

describe("cleanText: type and length gates", () => {
  test("non-strings are INVALID_INPUT", () => {
    for (const raw of [undefined, null, 42, {}, [], true, Symbol("x")]) {
      expect(code(cleanText(raw, { max: 10 }))).toBe("INVALID_INPUT");
    }
  });

  test("raw longer than max * 4 is TOO_LONG even if it would clean to nothing", () => {
    expect(code(cleanText(" ".repeat(41), { max: 10 }))).toBe("TOO_LONG");
    expect(value(cleanText(" ".repeat(40), { max: 10 }))).toBe("");
  });

  test("the raw cap is checked before scanning: a 1 MB string returns TOO_LONG in < 50 ms", () => {
    const huge = "a".repeat(1024 * 1024);
    const start = performance.now();
    const r = cleanText(huge, { max: 2000 });
    const elapsed = performance.now() - start;
    expect(code(r)).toBe("TOO_LONG");
    expect(elapsed).toBeLessThan(50);
  });

  test("a 1 MB string within the cap is cleaned in linear time (< 50 ms)", () => {
    const huge = "ab \t​\n".repeat(1024 * 1024 / 6);
    const start = performance.now();
    const r = cleanText(huge, { max: 1024 * 1024, multiline: true });
    const elapsed = performance.now() - start;
    expect(r.ok).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });

  test("cleaned text longer than max is TOO_LONG; exactly max is fine", () => {
    expect(value(cleanText("abcde", { max: 5 }))).toBe("abcde");
    expect(code(cleanText("abcdef", { max: 5 }))).toBe("TOO_LONG");
    // Stripped characters do not count toward max.
    expect(value(cleanText("a​b​c​d​e", { max: 5 }))).toBe("abcde");
  });

  test("min: shorter than min after cleaning is VALIDATION_FAILED; min 0 allows empty", () => {
    expect(code(cleanText("  a  ", { max: 10, min: 2 }))).toBe("VALIDATION_FAILED");
    expect(code(cleanText("​​", { max: 10, min: 1 }))).toBe("VALIDATION_FAILED");
    expect(value(cleanText("   ", { max: 10 }))).toBe("");
    expect(value(cleanText("", { max: 10, min: 0 }))).toBe("");
    expect(value(cleanText(" ab ", { max: 10, min: 2 }))).toBe("ab");
  });

  test("invalid options are a programmer error", () => {
    expect(() => cleanText("x", { max: 0 })).toThrow(RangeError);
    expect(() => cleanText("x", { max: 1.5 })).toThrow(RangeError);
    expect(() => cleanText("x", { max: 5, min: 6 })).toThrow(RangeError);
    expect(() => cleanText("x", { max: 5, min: -1 })).toThrow(RangeError);
  });
});

describe("cleanText: cleaning", () => {
  test("HTML is not parsed or encoded", () => {
    expect(value(cleanText("<script>x</script>", { max: 100 }))).toBe("<script>x</script>");
    expect(value(cleanText("a &amp; <b>b</b> \"q\" 'r'", { max: 100 }))).toBe("a &amp; <b>b</b> \"q\" 'r'");
  });

  test("strips C0 and C1 controls and DEL", () => {
    let raw = "a";
    for (let c = 0; c <= 0x1f; c++) if (![0x09, 0x0a, 0x0b, 0x0c, 0x0d].includes(c)) raw += String.fromCharCode(c);
    for (let c = 0x7f; c <= 0x9f; c++) raw += String.fromCharCode(c);
    raw += "b";
    expect(value(cleanText(raw, { max: 100 }))).toBe("ab");
    expect(value(cleanText(raw, { max: 100, multiline: true }))).toBe("ab");
  });

  test("strips zero-width and bidi control characters", () => {
    const invisible = "​‌‍‎‏⁠﻿‪‫‬‭‮⁦⁧⁨⁩";
    expect(value(cleanText(`${invisible}pay${invisible}pal${invisible}`, { max: 100 }))).toBe("paypal");
    // Trojan-source style override hidden inside text.
    expect(value(cleanText("abc‮dcba", { max: 100 }))).toBe("abcdcba");
  });

  test("collapses spaces and tabs, trims", () => {
    expect(value(cleanText("  hello \t\t  world  ", { max: 100 }))).toBe("hello world");
    expect(value(cleanText("a\tb", { max: 100 }))).toBe("a b");
    expect(value(cleanText("a ​ b", { max: 100 }))).toBe("a b");
  });

  test("single-line: line breaks become a single space", () => {
    expect(value(cleanText("line one\r\nline two\n\n\nthree\rfour", { max: 100 }))).toBe("line one line two three four");
  });

  test("multiline: keeps \\n, converts \\r\\n and lone \\r, collapses 3+ breaks to 2", () => {
    expect(value(cleanText("a\r\nb", { max: 100, multiline: true }))).toBe("a\nb");
    expect(value(cleanText("a\rb", { max: 100, multiline: true }))).toBe("a\nb");
    expect(value(cleanText("a\n\nb", { max: 100, multiline: true }))).toBe("a\n\nb");
    expect(value(cleanText("a\n\n\n\n\nb", { max: 100, multiline: true }))).toBe("a\n\nb");
    expect(value(cleanText("a\r\n\r\n\r\n\r\nb", { max: 100, multiline: true }))).toBe("a\n\nb");
    expect(value(cleanText("a b c", { max: 100, multiline: true }))).toBe("a\nb\nc");
  });

  test("multiline: spaces around line breaks and leading/trailing breaks are dropped", () => {
    expect(value(cleanText("\n\n  a  \n  b  \n\n", { max: 100, multiline: true }))).toBe("a\nb");
    expect(value(cleanText("a \t\n\t b", { max: 100, multiline: true }))).toBe("a\nb");
  });

  test("keeps non-ASCII text, emoji and surrogate pairs intact", () => {
    expect(value(cleanText("  Grüße, 東京 \u{1F600}  ", { max: 100 }))).toBe("Grüße, 東京 \u{1F600}");
  });
});

describe("cleanText: Unicode whitespace and fillers", () => {
  test("every White_Space code point collapses and trims", () => {
    const spaces = "\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000";
    expect(code(cleanText(spaces, { max: 50, min: 1 }))).toBe("VALIDATION_FAILED");
    expect(code(cleanText("\u00a0", { max: 50, min: 1 }))).toBe("VALIDATION_FAILED");
    expect(value(cleanText("\u00a0a\u00a0\u00a0b\u3000", { max: 50 }))).toBe("a b");
    expect(value(cleanText(`x${spaces}y`, { max: 50 }))).toBe("x y");
    expect(value(cleanText(`x${spaces}\n${spaces}y`, { max: 50, multiline: true }))).toBe("x\ny");
  });

  test("U+0085 (NEL) is stripped as a C1 control, so NEL-only text is still empty", () => {
    expect(value(cleanText("a\u0085b", { max: 50 }))).toBe("ab");
    expect(code(cleanText("\u0085\u0085", { max: 50, min: 1 }))).toBe("VALIDATION_FAILED");
  });

  test("Hangul fillers are stripped", () => {
    expect(code(cleanText("\u3164\uffa0\u3164", { max: 50, min: 1 }))).toBe("VALIDATION_FAILED");
    expect(value(cleanText("a\u3164b\uffa0c", { max: 50 }))).toBe("abc");
  });
});

describe("countUrls", () => {
  test("counts http, https and www tokens", () => {
    expect(countUrls("")).toBe(0);
    expect(countUrls("no links here")).toBe(0);
    expect(countUrls("see http://a.example and https://b.example/x?y=1")).toBe(2);
    expect(countUrls("go to www.example.com now")).toBe(1);
    expect(countUrls("HTTPS://SHOUT.example WWW.LOUD.example")).toBe(2);
  });

  test("a URL with www counts once; adjacent text does not double count", () => {
    expect(countUrls("https://www.example.com")).toBe(1);
    expect(countUrls("http://a.example/http://b.example")).toBe(2);
    expect(countUrls("(www.a.example)")).toBe(1);
  });

  test("URLs separated by punctuation each count", () => {
    expect(countUrls("http://a.com,http://b.com,http://c.com")).toBe(3);
    expect(countUrls("<http://a.com><http://b.com>")).toBe(2);
    expect(countUrls("visithttp://spam.com")).toBe(1);
    expect(countUrls("http:// https://")).toBe(2);
    expect(countUrls("https://www.a.com,www.b.com")).toBe(2);
    expect(countUrls("https://x ".repeat(1000))).toBe(1000);
  });

  test("www needs a word boundary; bare words are not URLs", () => {
    expect(countUrls("awww.cute")).toBe(0);
    expect(countUrls("http https www")).toBe(0);
    expect(countUrls("http:/broken")).toBe(0);
  });

  test("linear time on adversarial input", () => {
    const text = "http:/".repeat(200_000) + "www".repeat(200_000);
    const start = performance.now();
    expect(countUrls(text)).toBe(0);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("normalizeCouponCode", () => {
  test("trims and upper-cases valid codes", () => {
    expect(value(normalizeCouponCode("  save10 "))).toBe("SAVE10");
    expect(value(normalizeCouponCode("Black_Friday-2026"))).toBe("BLACK_FRIDAY-2026");
    expect(value(normalizeCouponCode("A".repeat(32)))).toBe("A".repeat(32));
  });

  test("rejects non-strings, empty, 33+ chars and inner spaces", () => {
    for (const raw of [undefined, null, 10, {}, "", "   ", "A".repeat(33), "SAVE 10", "SAVE\t10", "x".repeat(10_000)]) {
      expect(code(normalizeCouponCode(raw))).toBe("COUPON_INVALID");
    }
  });

  test("rejects punctuation, SQL-ish and unicode look-alikes (checked before upper-casing)", () => {
    for (const raw of [
      "SAVE10%",
      "' OR 1=1 --",
      "SAVE.10",
      "SAVEı", // dotless i -> "I" when upper-cased
      "ſAVE", // long s -> "S" when upper-cased
      "straße", // sharp s -> "SS"
      "SАVE", // Cyrillic A
      "SAVE１", // fullwidth 1
      "SA​VE", // zero-width space
      "\ufeffSAVE10", // BOM (trim() would drop it)
      "SAVE10\ufeff",
      "\u200bSAVE10",
      "SAVE10\u2060",
      "\u202eSAVE10",
      "SAVE10\u3164",
    ]) {
      expect(code(normalizeCouponCode(raw))).toBe("COUPON_INVALID");
    }
  });
});
