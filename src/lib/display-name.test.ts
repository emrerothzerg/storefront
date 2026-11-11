import { describe, expect, test } from "bun:test";

import { MAX_VISIBLE_NAME_LENGTH, cleanDisplayName, truncateDisplayName } from "./display-name";
import * as headerModel from "@/components/organisms/SiteHeader/header-model";

const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // man, ZWJ, woman, ZWJ, girl
const PERSIAN = "می‌خواهم"; // "mi-khaham" with a ZWNJ
const RLO = "‮";

describe("cleanDisplayName", () => {
  test("collapses whitespace and control characters into single spaces; trims; non-strings become empty", () => {
    expect(cleanDisplayName("  Ada \n\t Lovelace\u0000 ")).toBe("Ada Lovelace");
    expect(cleanDisplayName("Ada\u0000\u0007\u001b[31mLove\u007flace")).toBe("Ada [31mLove lace");
    expect(cleanDisplayName("Ada\u0085\u009bLovelace")).toBe("Ada Lovelace");
    expect(cleanDisplayName(42)).toBe("");
    expect(cleanDisplayName(null)).toBe("");
    expect(cleanDisplayName(undefined)).toBe("");
  });

  test("ordinary names are unchanged", () => {
    for (const name of ["Ada Lovelace", "Grace Hopper", "Zoë", "李小龙", "O'Brien-Smith"]) {
      expect(cleanDisplayName(name)).toBe(name);
    }
  });

  test("a ZWJ emoji sequence stays intact", () => {
    expect(cleanDisplayName(FAMILY)).toBe(FAMILY);
    expect(cleanDisplayName(`Ada ${FAMILY}`)).toBe(`Ada ${FAMILY}`);
    expect(Array.from(cleanDisplayName(FAMILY))).toHaveLength(5);
  });

  test("ZWNJ inside a Persian word is kept", () => {
    expect(cleanDisplayName(PERSIAN)).toBe(PERSIAN);
    expect(cleanDisplayName(PERSIAN)).toContain("‌");
  });

  test("bidi overrides, isolates and marks are removed", () => {
    expect(cleanDisplayName(`Ada${RLO}ecalevoL`)).toBe("AdaecalevoL");
    for (const ch of ["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩", "‎", "‏", "؜"]) {
      const out = cleanDisplayName(`Ada${ch} Love`);
      expect([ch, out]).toEqual([ch, "Ada Love"]);
    }
  });

  test("other format characters (ZWSP, word joiner, BOM, soft hyphen) are removed", () => {
    expect(cleanDisplayName("Oak​Desk⁠﻿")).toBe("OakDesk");
    expect(cleanDisplayName("Ada­Lovelace")).toBe("AdaLovelace");
  });

  test("joiners that do not join two visible characters are dropped", () => {
    expect(cleanDisplayName("‍Ada‌")).toBe("Ada");
    expect(cleanDisplayName("Ada ‍ Love")).toBe("Ada Love");
    expect(cleanDisplayName("Ada‍ Love")).toBe("Ada Love");
    expect(cleanDisplayName("‌‍")).toBe("");
    expect(cleanDisplayName(`${RLO}‍ `)).toBe("");
  });

  test("idempotent", () => {
    for (const raw of [FAMILY, PERSIAN, `  Ada${RLO}\u0000 ‍ Love\t`, "a‍\u0000b"]) {
      const once = cleanDisplayName(raw);
      expect(cleanDisplayName(once)).toBe(once);
    }
  });

  test("linear on large hostile input", () => {
    const raw = `${"‍ ‮\u0000".repeat(50_000)}x`;
    const started = performance.now();
    expect(cleanDisplayName(raw)).toBe("x");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("truncateDisplayName", () => {
  test("keeps <= 20 code points and appends an ellipsis", () => {
    expect(MAX_VISIBLE_NAME_LENGTH).toBe(20);
    expect(truncateDisplayName("Ada")).toBe("Ada");
    expect(truncateDisplayName("a".repeat(20))).toBe("a".repeat(20));
    expect(truncateDisplayName("a".repeat(21))).toBe(`${"a".repeat(20)}…`);
  });

  test("never splits a surrogate pair; trailing space before the cut is trimmed", () => {
    const out = truncateDisplayName("\u{1F600}".repeat(25));
    expect(Array.from(out)).toHaveLength(21);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(truncateDisplayName(`${"a".repeat(19)} bcdef`)).toBe(`${"a".repeat(19)}…`);
  });

  test("a joiner left at the cut is removed", () => {
    // 19 letters + man + ZWJ + woman: the cut after 20 code points would end in "man"; after 21 in a ZWJ.
    const name = `${"a".repeat(19)}${FAMILY}`;
    expect(truncateDisplayName(name, 21)).toBe(`${"a".repeat(19)}\u{1F468}…`);
    expect(truncateDisplayName(name, 21)).not.toContain("‍");
  });
});

describe("header-model re-exports (CONS-B4 bh)", () => {
  test("SiteHeader's header-model re-exports the same functions", () => {
    expect(headerModel.cleanDisplayName).toBe(cleanDisplayName);
    expect(headerModel.truncateDisplayName).toBe(truncateDisplayName);
    expect(headerModel.MAX_VISIBLE_NAME_LENGTH).toBe(MAX_VISIBLE_NAME_LENGTH);
  });
});
