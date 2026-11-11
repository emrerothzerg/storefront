/**
 * QA adversarial suite for src/lib/validation.ts (T06, criteria 2, 3, 4, 7).
 * Independent of the author's colocated tests.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_QUANTITY,
  luhnCheck,
  validateAddress,
  validateCard,
  validateQuantity,
} from "@/lib/validation";

const roundTrip = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

// ---------------------------------------------------------------------------
// Quantity (criterion 2)
// ---------------------------------------------------------------------------

describe("validateQuantity", () => {
  test("default max is 99", () => {
    expect(DEFAULT_MAX_QUANTITY).toBe(99);
  });

  test.each([1, 2, 50, 98, 99])("accepts %p", (q) => {
    expect(validateQuantity(q)).toEqual({ ok: true, value: q });
  });

  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["0", 0, "ZERO"],
    ["-0", -0, "ZERO"],
    ["-1", -1, "NEGATIVE"],
    ["-99", -99, "NEGATIVE"],
    ["MIN_SAFE_INTEGER", Number.MIN_SAFE_INTEGER, "NEGATIVE"],
    ["0.1 + 0.2", 0.1 + 0.2, "NOT_INTEGER"],
    ["1.5", 1.5, "NOT_INTEGER"],
    ["99.0000001", 99.0000001, "NOT_INTEGER"],
    ["Number.EPSILON", Number.EPSILON, "NOT_INTEGER"],
    ["-0.5", -0.5, "NOT_INTEGER"],
    ["NaN", Number.NaN, "NAN"],
    ["Infinity", Number.POSITIVE_INFINITY, "INFINITE"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "INFINITE"],
    ["100", 100, "ABOVE_MAX"],
    ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER, "ABOVE_MAX"],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1, "ABOVE_MAX"],
    ["1e21", 1e21, "ABOVE_MAX"],
    ["string '5'", "5", "NOT_A_NUMBER"],
    ["empty string", "", "NOT_A_NUMBER"],
    ["BigInt-like string", "9007199254740993", "NOT_A_NUMBER"],
    ["bigint 5n", BigInt(5), "NOT_A_NUMBER"],
    ["object with valueOf", { valueOf: () => 5 }, "NOT_A_NUMBER"],
    ["Number object", new Number(5), "NOT_A_NUMBER"],
    ["array [5]", [5], "NOT_A_NUMBER"],
    ["null", null, "NOT_A_NUMBER"],
    ["undefined", undefined, "NOT_A_NUMBER"],
    ["prototype-less object", Object.create(null), "NOT_A_NUMBER"],
    ["true", true, "NOT_A_NUMBER"],
    ["very long string", "9".repeat(100_000), "NOT_A_NUMBER"],
  ];

  test.each(cases)("rejects %s with reason %s", (_l, v, reason) => {
    const r = validateQuantity(v);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_QUANTITY");
      expect(r.error.details.reason).toBe(reason as never);
      expect(r.error.details.max).toBe(99);
      expect(typeof r.error.message).toBe("string");
      expect(r.error.message.length).toBeGreaterThan(0);
    }
  });

  test("all seven reasons are produced and distinct", () => {
    const reasons = new Set<string>(
      ["x", Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 0, 100].map((v) => {
        const r = validateQuantity(v);
        return r.ok ? "OK" : r.error.details.reason;
      }),
    );
    expect([...reasons].sort()).toEqual(
      ["ABOVE_MAX", "INFINITE", "NAN", "NEGATIVE", "NOT_A_NUMBER", "NOT_INTEGER", "ZERO"].sort(),
    );
  });

  test("custom max boundaries", () => {
    expect(validateQuantity(1, 1)).toEqual({ ok: true, value: 1 });
    const r = validateQuantity(2, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details).toEqual({ reason: "ABOVE_MAX", max: 1 });
    expect(validateQuantity(10, 10).ok).toBe(true);
    expect(validateQuantity(11, 10).ok).toBe(false);
  });

  test("results are JSON-serializable", () => {
    for (const r of [validateQuantity(3), validateQuantity(0), validateQuantity(Number.NaN)]) {
      expect(roundTrip(r)).toEqual(r);
    }
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["0", 0],
    ["-0", -0],
    ["-1", -1],
    ["1.5", 1.5],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
    ["string '99'", "99"],
    ["null", null],
  ])("ruling 4: max=%s throws TypeError", (_l, max) => {
    expect(() => validateQuantity(5, max as number)).toThrow(TypeError);
  });

  test("ruling 4: smallest and largest valid max are accepted; undefined uses the default", () => {
    expect(validateQuantity(1, 1)).toEqual({ ok: true, value: 1 });
    expect(validateQuantity(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).ok).toBe(true);
    const r = validateQuantity(100, undefined);
    expect(!r.ok && r.error.details).toEqual({ reason: "ABOVE_MAX", max: 99 });
  });
});

// ---------------------------------------------------------------------------
// Address (criterion 4)
// ---------------------------------------------------------------------------

const ADDRESS = {
  fullName: "Jane Doe",
  email: "jane@example.com",
  line1: "1 Main St",
  city: "Springfield",
  region: "IL",
  postalCode: "62701",
  country: "US",
} as const;

const REQUIRED_ADDRESS_FIELDS = ["fullName", "email", "line1", "city", "region", "postalCode", "country"] as const;

// Unicode whitespace that String.prototype.trim must strip.
const WHITESPACE: ReadonlyArray<readonly [string, string]> = [
  ["space", "   "],
  ["tab/newline", "\t\n\r"],
  ["NBSP U+00A0", " "],
  ["ideographic space U+3000", "　"],
  ["em space U+2003", " "],
  ["BOM U+FEFF", "﻿"],
  ["line separator U+2028", " "],
  ["mixed", "  　\t "],
];

function fieldCode(r: ReturnType<typeof validateAddress>, field: string): string | undefined {
  if (r.ok) return undefined;
  return (r.error.details.fields as Record<string, { code: string } | undefined>)[field]?.code;
}

describe("validateAddress", () => {
  test("accepts a valid address and returns only known fields", () => {
    const r = validateAddress({ ...ADDRESS, isAdmin: true, __proto__x: 1 });
    expect(r).toEqual({ ok: true, value: { ...ADDRESS } });
  });

  for (const field of REQUIRED_ADDRESS_FIELDS) {
    test.each(WHITESPACE)(`${field}: whitespace-only (%s) is REQUIRED`, (_l, ws) => {
      expect(fieldCode(validateAddress({ ...ADDRESS, [field]: ws }), field)).toBe("REQUIRED");
    });
    test(`${field}: empty, missing, null, undefined are REQUIRED`, () => {
      expect(fieldCode(validateAddress({ ...ADDRESS, [field]: "" }), field)).toBe("REQUIRED");
      expect(fieldCode(validateAddress({ ...ADDRESS, [field]: null }), field)).toBe("REQUIRED");
      expect(fieldCode(validateAddress({ ...ADDRESS, [field]: undefined }), field)).toBe("REQUIRED");
      const rest: Record<string, unknown> = { ...ADDRESS };
      delete rest[field];
      expect(fieldCode(validateAddress(rest), field)).toBe("REQUIRED");
    });
    test(`${field}: non-string values are INVALID_TYPE`, () => {
      for (const v of [42, true, [], {}, { toString: () => "x" }, Object.create(null), BigInt(1)]) {
        expect(fieldCode(validateAddress({ ...ADDRESS, [field]: v }), field)).toBe("INVALID_TYPE");
      }
    });
  }

  test("trims unicode whitespace from every field value", () => {
    const pad = (s: string) => `　  ${s}\t `;
    const r = validateAddress({
      fullName: pad("Jane Doe"),
      email: pad("jane@example.com"),
      line1: pad("1 Main St"),
      line2: pad("Apt 2"),
      city: pad("Springfield"),
      region: pad("IL"),
      postalCode: pad("62701"),
      country: pad("us"),
    });
    expect(r).toEqual({ ok: true, value: { ...ADDRESS, line2: "Apt 2" } });
  });

  test.each(WHITESPACE)("optional line2 whitespace-only (%s) is dropped, not an error", (_l, ws) => {
    const r = validateAddress({ ...ADDRESS, line2: ws });
    expect(r.ok).toBe(true);
    if (r.ok) expect("line2" in r.value).toBe(false);
  });

  test.each([
    ["a@b", false],
    ["a@@b.com", false],
    ['"a b"@c.com', false],
    ["a b@c.com", false],
    ["@b.com", false],
    ["a@.com", false],
    ["a@b.", false],
    ["a@b.c@d.com", false],
    ["a b@c.com", false],
    ["a@b.co", true],
    ["first.last+tag@sub.example.co.uk", true],
  ] as const)("email %p valid=%p", (email, valid) => {
    const r = validateAddress({ ...ADDRESS, email });
    if (valid) expect(r.ok).toBe(true);
    else expect(fieldCode(r, "email")).toBe("INVALID_EMAIL");
  });

  test("length boundaries: 200/201 for text fields, 254/255 for email (after trim)", () => {
    expect(validateAddress({ ...ADDRESS, line1: "x".repeat(200) }).ok).toBe(true);
    expect(validateAddress({ ...ADDRESS, line1: `  ${"x".repeat(200)}  ` }).ok).toBe(true);
    expect(fieldCode(validateAddress({ ...ADDRESS, line1: "x".repeat(201) }), "line1")).toBe("TOO_LONG");
    const email254 = `${"a".repeat(254 - "@b.co".length)}@b.co`;
    expect(email254.length).toBe(254);
    expect(validateAddress({ ...ADDRESS, email: email254 }).ok).toBe(true);
    expect(fieldCode(validateAddress({ ...ADDRESS, email: `a${email254}` }), "email")).toBe("TOO_LONG");
  });

  test("very long strings are rejected quickly", () => {
    const huge = "x".repeat(1_000_000);
    const t0 = performance.now();
    const r = validateAddress({ ...ADDRESS, fullName: huge, email: `${huge}@b.com` });
    expect(performance.now() - t0).toBeLessThan(200);
    expect(fieldCode(r, "fullName")).toBe("TOO_LONG");
    expect(fieldCode(r, "email")).toBe("TOO_LONG");
    expect(JSON.stringify(r).length).toBeLessThan(2000); // input not echoed
  });

  test("country: two letters only, upper-cased", () => {
    expect(validateAddress({ ...ADDRESS, country: "de" })).toEqual({ ok: true, value: { ...ADDRESS, country: "DE" } });
    for (const c of ["U", "USA", "1A", "U S", "ÜS"]) {
      expect(fieldCode(validateAddress({ ...ADDRESS, country: c }), "country")).toBe("INVALID_COUNTRY");
    }
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["array", [ADDRESS]],
    ["string", "Jane Doe"],
    ["number", 7],
  ])("non-object input (%s) reports every required field", (_l, input) => {
    const r = validateAddress(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("VALIDATION_FAILED");
      expect(Object.keys(r.error.details.fields).sort()).toEqual([...REQUIRED_ADDRESS_FIELDS].sort());
    }
  });

  test("prototype-less object input is accepted", () => {
    const input = Object.assign(Object.create(null) as object, ADDRESS);
    expect(validateAddress(input)).toEqual({ ok: true, value: { ...ADDRESS } });
  });

  test("JSON __proto__ payload does not pollute Object.prototype", () => {
    validateAddress(JSON.parse(`{"__proto__":{"polluted":1},"fullName":"x"}`));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("success and failure results are JSON-serializable", () => {
    for (const r of [
      validateAddress({ ...ADDRESS, line2: "Apt 2" }),
      validateAddress({ ...ADDRESS, email: "a@b", fullName: " " }),
      validateAddress(null),
    ]) {
      expect(roundTrip(r)).toEqual(r);
    }
  });

  test.each([
    ["ZWSP U+200B", "\u200b"],
    ["ZWNJ U+200C", "\u200c"],
    ["ZWJ U+200D", "\u200d"],
    ["word joiner U+2060", "\u2060"],
    ["BOM U+FEFF", "\ufeff"],
    ["mixed zero-width + whitespace", "\u200b \u00a0\u2060\u3000\u200d"],
  ])("ruling 5: zero-width-only value (%s) is REQUIRED for every required field", (_l, zw) => {
    for (const field of REQUIRED_ADDRESS_FIELDS) {
      expect(fieldCode(validateAddress({ ...ADDRESS, [field]: zw }), field)).toBe("REQUIRED");
    }
    const r = validateAddress({ ...ADDRESS, line2: zw });
    expect(r.ok && "line2" in r.value).toBe(false);
  });

  test("ruling 5: zero-width chars are trimmed at the edges but kept inside", () => {
    const r = validateAddress({ ...ADDRESS, fullName: "\u200b\u2060Jane\u200dDoe\ufeff\u200c", country: "\u200bus\u200b" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fullName).toBe("Jane\u200dDoe");
      expect(r.value.country).toBe("US");
    }
  });

  test.each([
    ["a@b..co", false],
    ["a@.b.co", false],
    ["a@b.co.", false],
    ["a@b...co", false],
    ["a@b.co..", false],
    ["a@b.c.o", true],
    ["a.b@c.co", true],
    ["a..b@c.co", true], // local part is deliberately not restricted
  ] as const)("ruling 5: email domain dots %p valid=%p", (email, valid) => {
    const r = validateAddress({ ...ADDRESS, email });
    if (valid) expect(r.ok).toBe(true);
    else expect(fieldCode(r, "email")).toBe("INVALID_EMAIL");
  });
});

// ---------------------------------------------------------------------------
// Card (criterion 3)
// ---------------------------------------------------------------------------

/** Appends a Luhn check digit to `body`. */
function withLuhn(body: string): string {
  for (let d = 0; d <= 9; d++) if (luhnCheck(body + d)) return body + d;
  throw new Error("unreachable");
}

const NOW = new Date("2026-11-06T12:00:00.000Z");
const VALID_NUMBER = "4242424242424242";
const CVC = "987";
const CARD = { number: VALID_NUMBER, expMonth: 12, expYear: 2030, cvc: CVC, nameOnCard: "Jane Doe" };

type CardRes = ReturnType<typeof validateCard>;
function cardCode(r: CardRes, field: string): string | undefined {
  if (r.ok) return undefined;
  return (r.error.details.fields as Record<string, { code: string } | undefined>)[field]?.code;
}

/** Every 6-digit window of the input's digits must be absent from the serialized failure. */
function expectNoLeak(r: CardRes, number: unknown, cvc: unknown) {
  expect(r.ok).toBe(false);
  const json = JSON.stringify(r);
  expect(json).not.toMatch(/\d{6,}/);
  if (typeof number === "string") {
    const digits = number.replace(/\D/g, "");
    for (let i = 0; i + 6 <= digits.length; i++) {
      expect(json.includes(digits.slice(i, i + 6))).toBe(false);
    }
  }
  if (!r.ok && typeof cvc === "string" && cvc.trim().length >= 2) {
    expect(JSON.stringify(r.error.details)).not.toContain(cvc.trim());
    expect(r.error.message).not.toContain(cvc.trim());
  }
}

describe("luhnCheck", () => {
  test("known values and hostile strings", () => {
    expect(luhnCheck("79927398713")).toBe(true);
    expect(luhnCheck("79927398710")).toBe(false);
    expect(luhnCheck("")).toBe(false);
    expect(luhnCheck("4242 4242 4242 4242")).toBe(false);
    expect(luhnCheck("４２４２")).toBe(false);
  });
});

describe("validateCard", () => {
  test("accepts a valid card and normalizes it", () => {
    expect(validateCard(CARD, NOW)).toEqual({
      ok: true,
      value: { ...CARD, last4: "4242" },
    });
  });

  test.each([
    ["spaces", "4242 4242 4242 4242"],
    ["hyphens", "4242-4242-4242-4242"],
    ["mixed separators", " 4242 - 4242\t4242-4242 "],
    ["NBSP separators", "4242 4242 4242 4242"],
  ])("number with %s is normalized to digits", (_l, number) => {
    const r = validateCard({ ...CARD, number }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.number).toBe(VALID_NUMBER);
  });

  test("length boundaries using Luhn-valid numbers: 12 and 20 fail, 13 and 19 pass", () => {
    const n12 = withLuhn("42424242424");
    const n13 = withLuhn("424242424242");
    const n19 = withLuhn("424242424242424242");
    const n20 = withLuhn("4242424242424242424");
    for (const n of [n12, n13, n19, n20]) expect(luhnCheck(n)).toBe(true);
    expect(cardCode(validateCard({ ...CARD, number: n12 }, NOW), "number")).toBe("INVALID_LENGTH");
    expect(validateCard({ ...CARD, number: n13 }, NOW).ok).toBe(true);
    expect(validateCard({ ...CARD, number: n19 }, NOW).ok).toBe(true);
    expect(cardCode(validateCard({ ...CARD, number: n20 }, NOW), "number")).toBe("INVALID_LENGTH");
  });

  test("bad Luhn: every single-digit change of a valid number fails", () => {
    for (let i = 0; i < VALID_NUMBER.length; i++) {
      const d = (Number(VALID_NUMBER[i]) + 1) % 10;
      const number = VALID_NUMBER.slice(0, i) + d + VALID_NUMBER.slice(i + 1);
      expect(cardCode(validateCard({ ...CARD, number }, NOW), "number")).toBe("FAILED_CHECKSUM");
    }
  });

  test.each([
    ["letters", "4242424242424a42"],
    ["dots", "4242.4242.4242.4242"],
    ["full-width digits", "４２４２４２４２４２４２４２４２"],
    ["plus sign", "+4242424242424242"],
    ["unicode minus", "4242−4242−4242−4242"],
    ["arabic-indic digits", "٤٢٤٢٤٢٤٢٤٢٤٢٤٢٤٢"],
  ])("non-digits (%s) are INVALID_CHARACTERS", (_l, number) => {
    expect(cardCode(validateCard({ ...CARD, number }, NOW), "number")).toBe("INVALID_CHARACTERS");
  });

  test.each([
    ["empty", ""],
    ["whitespace", "  　 "],
    ["null", null],
    ["undefined", undefined],
  ])("missing number (%s) is REQUIRED", (_l, number) => {
    expect(cardCode(validateCard({ ...CARD, number }, NOW), "number")).toBe("REQUIRED");
  });

  describe("expiry (UTC, valid through end of month, injected now)", () => {
    test("last millisecond of the expiry month passes; first ms of next month fails", () => {
      const card = { ...CARD, expMonth: 11, expYear: 2026 };
      expect(validateCard(card, new Date("2026-11-30T23:59:59.999Z")).ok).toBe(true);
      expect(cardCode(validateCard(card, new Date("2026-12-01T00:00:00.000Z")), "expMonth")).toBe("EXPIRED");
    });
    test("year rollover", () => {
      const card = { ...CARD, expMonth: 12, expYear: 26 };
      expect(validateCard(card, new Date("2026-12-31T23:59:59.999Z")).ok).toBe(true);
      expect(cardCode(validateCard(card, new Date("2027-01-01T00:00:00.000Z")), "expMonth")).toBe("EXPIRED");
    });
    test("comparison is UTC, not local offset", () => {
      // 00:30 on Dec 1 in UTC+01:00 is still Nov 30 in UTC.
      const card = { ...CARD, expMonth: 11, expYear: 2026 };
      expect(validateCard(card, new Date("2026-12-01T00:30:00+01:00")).ok).toBe(true);
    });
    test("last month is expired", () => {
      expect(cardCode(validateCard({ ...CARD, expMonth: 10, expYear: 2026 }, NOW), "expMonth")).toBe("EXPIRED");
    });
    test.each([
      [26, 2026],
      ["26", 2026],
      ["30", 2030],
      [46, 2046],
      [2046, 2046],
    ])("2-digit/4-digit year %p -> %p", (expYear, expected) => {
      const r = validateCard({ ...CARD, expYear }, NOW);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.expYear).toBe(expected);
    });
    test.each([47, 2047, 99, 100, 1999, -1, 1e21, 26.5, "2a", "", null, "20266"])(
      "implausible/invalid year %p is INVALID_YEAR",
      (expYear) => {
        expect(cardCode(validateCard({ ...CARD, expYear }, NOW), "expYear")).toBe("INVALID_YEAR");
      },
    );
    test.each([0, 13, -1, 1.5, "1.0", "", null, undefined, true, "0x1"])("month %p is INVALID_MONTH", (expMonth) => {
      expect(cardCode(validateCard({ ...CARD, expMonth }, NOW), "expMonth")).toBe("INVALID_MONTH");
    });
    test.each([1, 12, "01", " 12 "])("month %p is accepted", (expMonth) => {
      expect(validateCard({ ...CARD, expMonth, expYear: 2030 }, NOW).ok).toBe(true);
    });
  });

  describe("cvc", () => {
    test.each(["123", "1234", " 123 "])("accepts %p", (cvc) => {
      expect(validateCard({ ...CARD, cvc }, NOW).ok).toBe(true);
    });
    test.each(["12", "12345", "12a", "1 23", "１２３"])("rejects %p as INVALID_CVC", (cvc) => {
      expect(cardCode(validateCard({ ...CARD, cvc }, NOW), "cvc")).toBe("INVALID_CVC");
    });
    test.each(["", "   ", null, undefined, 123])("%p is REQUIRED", (cvc) => {
      expect(cardCode(validateCard({ ...CARD, cvc }, NOW), "cvc")).toBe("REQUIRED");
    });
  });

  test("name on card: unicode whitespace is REQUIRED, 100/101 length boundary", () => {
    expect(cardCode(validateCard({ ...CARD, nameOnCard: "　 " }, NOW), "nameOnCard")).toBe("REQUIRED");
    expect(validateCard({ ...CARD, nameOnCard: "x".repeat(100) }, NOW).ok).toBe(true);
    expect(cardCode(validateCard({ ...CARD, nameOnCard: "x".repeat(101) }, NOW), "nameOnCard")).toBe("TOO_LONG");
  });

  describe("failures never leak the card number (6+ digit run) or CVC", () => {
    const n20 = withLuhn("4242424242424242424");
    const leakCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["bad Luhn", { ...CARD, number: "4242424242424241" }],
      ["12 digits", { ...CARD, number: withLuhn("42424242424") }],
      ["20 digits Luhn-valid", { ...CARD, number: n20 }],
      ["very long digit string", { ...CARD, number: "4".repeat(100_000) }],
      ["letters", { ...CARD, number: "4242-4242-abcd-4242" }],
      ["valid number, expired", { ...CARD, expMonth: 1, expYear: 2020 }],
      ["valid number, bad cvc 2", { ...CARD, cvc: "98" }],
      ["valid number, bad cvc 5", { ...CARD, cvc: "98765" }],
      ["valid number, no name", { ...CARD, nameOnCard: "" }],
      ["valid number, bad month", { ...CARD, expMonth: 13 }],
      ["all bad", { number: "1234567890123", expMonth: 0, expYear: 1, cvc: "87654", nameOnCard: " " }],
      ["number-typed number", { ...CARD, number: 4242424242424242 }],
    ];
    test.each(leakCases)("%s", (_l, input) => {
      expectNoLeak(validateCard(input, NOW), input.number, input.cvc);
    });
  });

  test.each([
    ["null", null],
    ["array", [CARD]],
    ["string", VALID_NUMBER],
  ])("non-object input (%s) reports every field without echoing it", (_l, input) => {
    const r = validateCard(input, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.error.details.fields).sort()).toEqual(
        ["cvc", "expMonth", "expYear", "nameOnCard", "number"],
      );
    }
    expect(JSON.stringify(r)).not.toContain(VALID_NUMBER);
  });

  test("success and failure results are JSON-serializable", () => {
    for (const r of [
      validateCard(CARD, NOW),
      validateCard({ ...CARD, number: "1", cvc: "1" }, NOW),
      validateCard(null, NOW),
    ]) {
      expect(roundTrip(r)).toEqual(r);
    }
  });

  describe("documented by design (ruling 7)", () => {
    test("success value contains full number and CVC (must not be returned to a client)", () => {
      const r = validateCard(CARD, NOW);
      expect(JSON.stringify(r)).toContain(VALID_NUMBER);
      expect(JSON.stringify(r)).toContain(CVC);
    });
    test("number passed as a JS number reports REQUIRED rather than INVALID_TYPE", () => {
      expect(cardCode(validateCard({ ...CARD, number: 4242424242424242 }, NOW), "number")).toBe("REQUIRED");
    });
  });

  describe("orchestrator rulings (card)", () => {
    test.each(["030", "0", "1", "202", "02026", " 030 ", 100, 999, 101.5])(
      "ruling 6: expYear %p (not exactly 2 or 4 digits) is INVALID_YEAR",
      (expYear) => {
        expect(cardCode(validateCard({ ...CARD, expYear }, NOW), "expYear")).toBe("INVALID_YEAR");
      },
    );
    test.each([
      [0, 2000],
      [99, 2099],
      ["00", 2000],
      ["99", 2099],
      [1000, 1000],
    ])("ruling 6: expYear %p maps to %p before range checks", (expYear, mapped) => {
      const r = validateCard({ ...CARD, expYear }, NOW);
      // 2000 is a plausible year but in the past; 2099 and 1000 are out of range.
      const code = mapped === 2000 ? ["expMonth", "EXPIRED"] : ["expYear", "INVALID_YEAR"];
      expect(cardCode(r, code[0] ?? "")).toBe(code[1]);
    });
    test.each(["0000000000000", "0000 0000 0000 0000", "0".repeat(19), "5555555555555555", "1".repeat(19)])(
      "ruling 6: all-identical digits %p are FAILED_CHECKSUM",
      (number) => {
        expect(cardCode(validateCard({ ...CARD, number }, NOW), "number")).toBe("FAILED_CHECKSUM");
      },
    );
    test("ruling 6: all-zero numbers pass Luhn, so the rejection is the new identical-digit rule", () => {
      expect(luhnCheck("0000000000000")).toBe(true);
      expect(luhnCheck("0".repeat(19))).toBe(true);
    });
    test("ruling 6: nearly-identical Luhn-valid number is still accepted", () => {
      const n = withLuhn("000000000000001");
      expect(new Set(n).size).toBeGreaterThan(1);
      expect(validateCard({ ...CARD, number: n }, NOW).ok).toBe(true);
    });
    test.each([
      ["Invalid Date", new Date("invalid")],
      ["NaN Date", new Date(Number.NaN)],
      ["string", "2026-11-06"],
      ["number", 1_700_000_000_000],
      ["null", null],
      ["date-like object", { getTime: (): number => 0, getUTCFullYear: (): number => 2026, getUTCMonth: (): number => 0 }],
    ] as ReadonlyArray<readonly [string, unknown]>)("ruling 6: now = %s throws TypeError", (_l, now) => {
      expect(() => validateCard(CARD, now as unknown as Date)).toThrow(TypeError);
    });
    test("ruling 6: omitted now defaults to the current date", () => {
      expect(validateCard({ ...CARD, expYear: new Date().getUTCFullYear() + 1 }).ok).toBe(true);
    });
  });
});
