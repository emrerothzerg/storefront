import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cleanDisplayName } from "@/lib/display-name";
import type { AppError, Result } from "@/lib/result";
import { cleanText } from "@/server/security/text-guard";
import {
  DISPLAY_NAME_MAX,
  EMAIL_MAX,
  emailLimiterKey,
  normalizeDisplayName,
  normalizeEmail,
  PASSWORD_MAX,
  PASSWORD_MIN,
  validatePassword,
} from "./password-policy";
import { WEAK_PASSWORDS } from "./weak-passwords";

/** `details.fields[field].code` of a failed result, or null when ok. */
function fieldCode(result: Result<unknown, AppError>, field: string): string | null {
  if (result.ok) return null;
  expect(result.error.code).toBe("VALIDATION_FAILED");
  const fields = result.error.details?.fields as Record<string, { code: string; message: string }> | undefined;
  return fields?.[field]?.code ?? "MISSING_FIELD";
}

describe("WEAK_PASSWORDS", () => {
  test("about 100+ lower-case entries including the obvious ones", () => {
    expect(WEAK_PASSWORDS.size).toBeGreaterThanOrEqual(100);
    for (const entry of WEAK_PASSWORDS) expect(entry).toBe(entry.toLowerCase());
    for (const must of [
      "password",
      "12345678",
      "qwerty123",
      "iloveyou",
      "letmein",
      "welcome1",
      "admin123",
      "northwind",
      "passw0rd",
      "password1990",
      "password2026",
      "aaaaaaaa",
      "1q2w3e4r",
    ]) {
      expect(WEAK_PASSWORDS.has(must)).toBe(true);
    }
  });
});

describe("validatePassword", () => {
  test("bounds are 8..128", () => {
    expect(PASSWORD_MIN).toBe(8);
    expect(PASSWORD_MAX).toBe(128);
  });

  test("length in UTF-16 code units (ruling K-10): 7/129 rejected, 8/128 accepted", () => {
    expect(fieldCode(validatePassword("Zx9!kLm", {}), "password")).toBe("TOO_SHORT");
    expect(validatePassword("Zx9!kLmq", {})).toEqual({ ok: true, value: "Zx9!kLmq" });
    const max = "Zx9!".repeat(32);
    expect(validatePassword(max, {})).toEqual({ ok: true, value: max });
    expect(fieldCode(validatePassword(`${max}a`, {}), "password")).toBe("TOO_LONG");
    expect(fieldCode(validatePassword("x".repeat(1024 * 1024), {}), "password")).toBe("TOO_LONG");
    // Astral characters count as two units each.
    expect(validatePassword("\u{1F600}".repeat(4), {}).ok).toBe(true); // 8 units
    expect(fieldCode(validatePassword(`${"\u{1F600}".repeat(3)}a`, {}), "password")).toBe("TOO_SHORT"); // 7 units
    expect(validatePassword("\u{1F600}".repeat(64), {}).ok).toBe(true); // 128 units
    expect(fieldCode(validatePassword("\u{1F600}".repeat(65), {}), "password")).toBe("TOO_LONG"); // 130 units
  });

  test("missing, empty and non-string are REQUIRED", () => {
    for (const raw of [undefined, null, "", 12345678, {}, ["password1!"]]) {
      expect(fieldCode(validatePassword(raw, {}), "password")).toBe("REQUIRED");
    }
  });

  test("every weak-list entry is rejected in original, upper and title case", () => {
    for (const entry of WEAK_PASSWORDS) {
      const title = entry.charAt(0).toUpperCase() + entry.slice(1);
      for (const variant of [entry, entry.toUpperCase(), title]) {
        const code = fieldCode(validatePassword(variant, {}), "password");
        expect(code).toBe(variant.length < PASSWORD_MIN ? "TOO_SHORT" : "WEAK");
      }
    }
  });

  test("equal to the email local part or the full email is WEAK (case-insensitive)", () => {
    const ctx = { email: "kate.smith@x.com" };
    expect(fieldCode(validatePassword("kate.smith", ctx), "password")).toBe("WEAK");
    expect(fieldCode(validatePassword("KATE.SMITH", ctx), "password")).toBe("WEAK");
    expect(fieldCode(validatePassword("Kate.Smith@X.com", ctx), "password")).toBe("WEAK");
    expect(validatePassword("kate.smith2", ctx).ok).toBe(true);
    expect(validatePassword("kate.smith", {}).ok).toBe(true);
  });

  test("never trims or alters the password", () => {
    expect(validatePassword(" pass phrase 99 ", {})).toEqual({ ok: true, value: " pass phrase 99 " });
    const nfd = "Café-long-pass";
    expect(validatePassword(nfd, {})).toEqual({ ok: true, value: nfd });
  });

  test("messages never echo the password", () => {
    for (const secret of ["Qz7#", "Qz7#".repeat(40), "northwind", "kate.smith"]) {
      const result = validatePassword(secret, { email: "kate.smith@x.com" });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});

describe("normalizeEmail", () => {
  test("NFC, trims spaces, lower-cases", () => {
    expect(normalizeEmail("  Kate@Example.COM ")).toEqual({ ok: true, value: "kate@example.com" });
    expect(normalizeEmail("JOSÉ@x.com")).toEqual(normalizeEmail("JOSÉ@x.com"));
    expect(normalizeEmail("JOSÉ@x.com")).toEqual({ ok: true, value: "josé@x.com" });
    // Kelvin sign: NFC maps it to "K", lower-case to "k" (deterministic, not locale dependent).
    expect(normalizeEmail("Kate@x.com")).toEqual({ ok: true, value: "kate@x.com" });
  });

  test("254 accepted, 255 and 1 MiB rejected quickly", () => {
    const domain = "@example.com";
    const at254 = `${"a".repeat(EMAIL_MAX - domain.length)}${domain}`;
    expect(at254.length).toBe(254);
    expect(normalizeEmail(at254)).toEqual({ ok: true, value: at254 });
    expect(fieldCode(normalizeEmail(`a${at254}`), "email")).toBe("TOO_LONG");
    const started = performance.now();
    expect(fieldCode(normalizeEmail(`${"a".repeat(1024 * 1024)}${domain}`), "email")).toBe("TOO_LONG");
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("rejects malformed shapes and hidden characters (PLAN A-102, ruling R-11)", () => {
    for (const raw of [
      "a@b@c.com",
      "nouser",
      "kate @x.com",
      "kate@x.com\u0000",
      "kate@x.com\n",
      "\tkate@x.com",
      "kate＠x.com",
      "kate​@x.com",
      "kate@x.com ",
      "﻿kate@x.com",
      "kate@x .com",
      "@x.com",
      "kate@",
      "@",
    ]) {
      expect(fieldCode(normalizeEmail(raw), "email")).toBe("INVALID");
    }
  });

  test("missing or blank is REQUIRED", () => {
    for (const raw of [undefined, null, 42, "", "   "]) {
      expect(fieldCode(normalizeEmail(raw), "email")).toBe("REQUIRED");
    }
  });
});

describe("normalizeDisplayName", () => {
  test("cleans and bounds 1..50", () => {
    expect(normalizeDisplayName("  Ada   Lovelace ")).toEqual({ ok: true, value: "Ada Lovelace" });
    expect(normalizeDisplayName("<script>")).toEqual({ ok: true, value: "<script>" });
    expect(normalizeDisplayName("x".repeat(DISPLAY_NAME_MAX)).ok).toBe(true);
    expect(fieldCode(normalizeDisplayName("x".repeat(DISPLAY_NAME_MAX + 1)), "displayName")).toBe("TOO_LONG");
    expect(fieldCode(normalizeDisplayName(""), "displayName")).toBe("REQUIRED");
    expect(fieldCode(normalizeDisplayName("\u0000\u0007​"), "displayName")).toBe("REQUIRED");
    expect(fieldCode(normalizeDisplayName(undefined), "displayName")).toBe("REQUIRED");
  });
});

describe("normalizeDisplayName: format characters and joiners (CONS-B4 bi)", () => {
  const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  const PERSIAN = "می‌خواهم";

  function value(raw: unknown): string | null {
    const r = normalizeDisplayName(raw);
    return r.ok ? r.value : null;
  }

  test("keeps a ZWJ emoji sequence and a Persian ZWNJ intact", () => {
    expect(value(FAMILY)).toBe(FAMILY);
    expect(value(`  Ada ${FAMILY} `)).toBe(`Ada ${FAMILY}`);
    expect(value(PERSIAN)).toBe(PERSIAN);
  });

  test("removes bidi overrides/isolates/marks, U+061C and other format characters", () => {
    expect(value("Ada‮ecalevoL")).toBe("AdaecalevoL");
    for (const ch of ["‪", "‭", "⁦", "⁩", "‎", "‏", "؜", "­", "᠎", "⁪", "​", "⁠", "﻿"]) {
      expect([ch, value(`Ada${ch}Love`)]).toEqual([ch, "AdaLove"]);
    }
  });

  test("joiners that do not join two visible characters are dropped", () => {
    expect(value("‍Ada‌")).toBe("Ada");
    expect(value("Ada ‍ Love")).toBe("Ada Love");
    expect(value("a‍\u0000b")).toBe("ab");
    expect(fieldCode(normalizeDisplayName("‍‌ ‮"), "displayName")).toBe("REQUIRED");
  });

  test("ordinary names clean exactly like cleanText 1..50 (no behaviour change)", () => {
    for (const raw of ["Ada Lovelace", "  Ada \t\n Lovelace ", "<script>", "Zoë", "李小龙", "a\u0000b", "ㅤAda", "x".repeat(50)]) {
      const expected = cleanText(raw, { max: DISPLAY_NAME_MAX, min: 1 });
      expect([raw, value(raw)]).toEqual([raw, expected.ok ? expected.value : null]);
    }
  });

  test("length bounds count the kept joiners; oversized raw input is rejected up front", () => {
    const kept = `${"x".repeat(DISPLAY_NAME_MAX - 3)}${"\u{1F468}‍"}y`; // 47 + 2 + 1 + 1 = 51 code units
    expect(fieldCode(normalizeDisplayName(kept), "displayName")).toBe("TOO_LONG");
    expect(value(`${"x".repeat(DISPLAY_NAME_MAX - 2)}‍y`)).toBe(`${"x".repeat(DISPLAY_NAME_MAX - 2)}‍y`);
    expect(fieldCode(normalizeDisplayName("‍".repeat(DISPLAY_NAME_MAX * 4 + 1)), "displayName")).toBe("TOO_LONG");
  });

  test("parity with the display cleaner (src/lib/display-name.ts)", () => {
    const corpus = [
      "Ada Lovelace",
      "  Ada \t\n Lovelace ",
      FAMILY,
      `Ada ${FAMILY}`,
      PERSIAN,
      "Ada‮ecalevoL",
      "Ada ⁦x⁩ Love",
      "‍Ada‌",
      "Ada ‍ Love",
      "Oak​Desk﻿",
      "Ada­Love؜",
      " Ada　Love ",
    ];
    for (const raw of corpus) {
      const server = value(raw);
      // Same result for every input without C0/C1 controls or Hangul fillers ...
      expect([raw, server]).toEqual([raw, cleanDisplayName(raw)]);
    }
    // ... and for every input, a stored name renders unchanged in the header.
    for (const raw of [...corpus, "Ada\u0000\u0007Love", "a‍\u0000b", "ㅤAdaﾠ", "x\u0085‍y"]) {
      const server = value(raw);
      if (server !== null) expect([raw, cleanDisplayName(server)]).toEqual([raw, server]);
    }
  });
});

describe("emailLimiterKey", () => {
  test("lower-case SHA-256 hex of the normalised email; never the email itself", () => {
    const key = emailLimiterKey("kate@x.com");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(createHash("sha256").update("kate@x.com").digest("hex"));
    expect(key).not.toBe(emailLimiterKey("kate@y.com"));
    expect(key).not.toContain("kate");
  });
});
