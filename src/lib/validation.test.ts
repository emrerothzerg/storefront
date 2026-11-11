import { describe, expect, test } from "bun:test";
import {
  MAX_RAW_FIELD_LENGTH,
  luhnCheck,
  validateAddress,
  validateCard,
  validateQuantity,
  type QuantityErrorReason,
} from "./validation";

// ---------------------------------------------------------------------------
// Quantity
// ---------------------------------------------------------------------------

function reason(value: unknown, max?: number): QuantityErrorReason | undefined {
  const r = validateQuantity(value, max);
  if (r.ok) return undefined;
  expect(r.error.code).toBe("INVALID_QUANTITY");
  return r.error.details.reason;
}

describe("validateQuantity", () => {
  test("boundaries: 1 and 99 pass, 0 and 100 fail", () => {
    expect(validateQuantity(1)).toEqual({ ok: true, value: 1 });
    expect(validateQuantity(99)).toEqual({ ok: true, value: 99 });
    expect(reason(0)).toBe("ZERO");
    expect(reason(100)).toBe("ABOVE_MAX");
  });

  test("custom max", () => {
    expect(validateQuantity(5, 5)).toEqual({ ok: true, value: 5 });
    expect(reason(6, 5)).toBe("ABOVE_MAX");
  });

  test("distinct reasons for each kind of bad input", () => {
    const cases: readonly [unknown, QuantityErrorReason][] = [
      [0, "ZERO"],
      [-0, "ZERO"],
      [-1, "NEGATIVE"],
      [-100, "NEGATIVE"],
      [1.5, "NOT_INTEGER"],
      [0.1, "NOT_INTEGER"],
      [-1.5, "NOT_INTEGER"],
      [NaN, "NAN"],
      [Infinity, "INFINITE"],
      [-Infinity, "INFINITE"],
      ["2", "NOT_A_NUMBER"],
      [null, "NOT_A_NUMBER"],
      [undefined, "NOT_A_NUMBER"],
      [{}, "NOT_A_NUMBER"],
      [100, "ABOVE_MAX"],
    ];
    for (const [value, expected] of cases) expect(reason(value)).toBe(expected);
    const distinct = new Set(cases.map(([, r]) => r));
    expect(distinct.size).toBe(7);
  });

  test("invalid max is a programmer error (TypeError)", () => {
    for (const max of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateQuantity(1, max)).toThrow(TypeError);
    }
    expect(() => validateQuantity(1, "99" as unknown as number)).toThrow(TypeError);
    expect(validateQuantity(1, 1)).toEqual({ ok: true, value: 1 });
  });

  test("error is user-safe and includes max", () => {
    const r = validateQuantity(100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe("Quantity cannot be more than 99.");
      expect(r.error.details.max).toBe(99);
    }
  });
});

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

const validAddress = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical St",
  city: "London",
  region: "Greater London",
  postalCode: "N1 1AA",
  country: "GB",
} as const;

function addressFieldCodes(input: unknown): Record<string, string> {
  const r = validateAddress(input);
  if (r.ok) return {};
  expect(r.error.code).toBe("VALIDATION_FAILED");
  return Object.fromEntries(
    Object.entries(r.error.details.fields).map(([k, v]) => [k, v?.code ?? ""]),
  );
}

describe("validateAddress", () => {
  test("accepts a valid address without line2", () => {
    expect(validateAddress(validAddress)).toEqual({ ok: true, value: validAddress });
  });

  test("trims fields, upper-cases country, keeps non-empty line2", () => {
    const r = validateAddress({
      ...validAddress,
      fullName: "  Ada Lovelace ",
      line2: " Flat 2 ",
      country: "gb",
    });
    expect(r).toEqual({
      ok: true,
      value: { ...validAddress, line2: "Flat 2" },
    });
  });

  test("drops whitespace-only line2", () => {
    const r = validateAddress({ ...validAddress, line2: "   " });
    expect(r.ok).toBe(true);
    if (r.ok) expect("line2" in r.value).toBe(false);
  });

  test("rejects each empty or whitespace-only required field", () => {
    const required = [
      "fullName",
      "email",
      "line1",
      "city",
      "region",
      "postalCode",
      "country",
    ] as const;
    for (const field of required) {
      for (const blank of ["", "   ", "\t\n", undefined]) {
        expect(addressFieldCodes({ ...validAddress, [field]: blank })).toEqual({
          [field]: "REQUIRED",
        });
      }
    }
  });

  test("non-object input reports every required field", () => {
    for (const input of [null, undefined, "x", 42, []]) {
      expect(Object.keys(addressFieldCodes(input)).sort()).toEqual(
        ["city", "country", "email", "fullName", "line1", "postalCode", "region"],
      );
    }
  });

  test("zero-width characters count as whitespace", () => {
    for (const zw of ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", " \u200B\t\u2060 "]) {
      expect(addressFieldCodes({ ...validAddress, fullName: zw })).toEqual({ fullName: "REQUIRED" });
    }
    const r = validateAddress({ ...validAddress, city: "\u200BLondon\uFEFF", line2: "\u200D" });
    expect(r).toEqual({ ok: true, value: validAddress });
  });

  test("trimming matches \\s plus zero-width characters for every UTF-16 code unit", () => {
    const zeroWidth = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
    const mismatches: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const ch = String.fromCharCode(code);
      const trimmable = /\s/.test(ch) || zeroWidth.has(code);
      const r = validateAddress({ ...validAddress, fullName: `${ch}Ada${ch}` });
      const got = r.ok ? r.value.fullName : undefined;
      if (got !== (trimmable ? "Ada" : `${ch}Ada${ch}`)) mismatches.push(code);
    }
    expect(mismatches).toEqual([]);
  });

  test("interior whitespace is kept; mixed edge runs are removed", () => {
    const r = validateAddress({
      ...validAddress,
      fullName: "\u200B\t \u00A0\u3000Ada  Lovelace\u2028\uFEFF\n",
    });
    expect(r.ok && r.value.fullName).toBe("Ada  Lovelace");
  });

  test("raw cap: 1,000 chars reach semantic checks, 1,001 are TOO_LONG before trimming", () => {
    expect(MAX_RAW_FIELD_LENGTH).toBe(1000);
    // 1,000 raw chars that trim to a valid value are accepted.
    const padded = " ".repeat(497) + "London" + " ".repeat(497);
    expect(validateAddress({ ...validAddress, city: padded })).toEqual({
      ok: true,
      value: validAddress,
    });
    // 1,001 raw chars are rejected even though they would trim to "London".
    expect(addressFieldCodes({ ...validAddress, city: padded + " " })).toEqual({
      city: "TOO_LONG",
    });
    expect(addressFieldCodes({ ...validAddress, email: "a".repeat(1001) })).toEqual({
      email: "TOO_LONG",
    });
  });

  test("huge whitespace-padded input is rejected fast (D-T11-2)", () => {
    const fullName = " ".repeat(200_000) + "x" + " ".repeat(200_000);
    const t0 = performance.now();
    const codes = addressFieldCodes({ ...validAddress, fullName, line1: "\u200B".repeat(500_000) });
    const elapsed = performance.now() - t0;
    expect(codes).toEqual({ fullName: "TOO_LONG", line1: "TOO_LONG" });
    expect(elapsed).toBeLessThan(100);
  });

  test("trimming a maximal whitespace field is fast", () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      validateAddress({ ...validAddress, fullName: " ".repeat(499) + "x" + "\u200B".repeat(500) });
    }
    expect(performance.now() - t0).toBeLessThan(500);
  });

  test("rejects non-string values", () => {
    expect(addressFieldCodes({ ...validAddress, city: 123 })).toEqual({ city: "INVALID_TYPE" });
  });

  test("basic email shape", () => {
    for (const email of ["a@b.co", " a.b+c@d.example.org "]) {
      expect(validateAddress({ ...validAddress, email }).ok).toBe(true);
    }
    for (const email of [
      "ada",
      "ada@",
      "@example.com",
      "ada@example",
      "a da@example.com",
      "a@b@c.com",
      "a@b..co",
      "a@.b.co",
      "a@b.co.",
      "a@b.",
      "a@.co",
    ]) {
      expect(addressFieldCodes({ ...validAddress, email })).toEqual({ email: "INVALID_EMAIL" });
    }
  });

  test("country must be two letters", () => {
    for (const country of ["G", "GBR", "1A", "G B", "United Kingdom"]) {
      expect(addressFieldCodes({ ...validAddress, country })).toEqual({
        country: "INVALID_COUNTRY",
      });
    }
  });

  test("length limits: 200 chars ok, 201 too long", () => {
    expect(validateAddress({ ...validAddress, line1: "a".repeat(200) }).ok).toBe(true);
    expect(addressFieldCodes({ ...validAddress, line1: "a".repeat(201) })).toEqual({
      line1: "TOO_LONG",
    });
  });

  test("collects multiple field errors at once", () => {
    expect(addressFieldCodes({ ...validAddress, city: "", email: "bad" })).toEqual({
      city: "REQUIRED",
      email: "INVALID_EMAIL",
    });
  });
});

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

// 15 Nov 2026 UTC.
const NOW = new Date(Date.UTC(2026, 10, 15, 12));
const VALID_NUMBER = "4242424242424242";
const validCard = {
  number: VALID_NUMBER,
  expMonth: 12,
  expYear: 2028,
  cvc: "123",
  nameOnCard: "Ada Lovelace",
} as const;

function cardFieldCodes(input: unknown, now: Date = NOW): Record<string, string> {
  const r = validateCard(input, now);
  if (r.ok) return {};
  expect(r.error.code).toBe("VALIDATION_FAILED");
  return Object.fromEntries(
    Object.entries(r.error.details.fields).map(([k, v]) => [k, v?.code ?? ""]),
  );
}

describe("luhnCheck", () => {
  test("known values", () => {
    expect(luhnCheck("4242424242424242")).toBe(true);
    expect(luhnCheck("4242424242424241")).toBe(false);
    expect(luhnCheck("378282246310005")).toBe(true); // Amex test number
    expect(luhnCheck("")).toBe(false);
    expect(luhnCheck("42a2")).toBe(false);
  });
});

describe("validateCard", () => {
  test("accepts a valid card and returns normalized data with last4", () => {
    expect(validateCard(validCard, NOW)).toEqual({
      ok: true,
      value: { ...validCard, last4: "4242" },
    });
  });

  test("strips spaces and dashes; trims name and cvc; accepts string expiry and 2-digit year", () => {
    const r = validateCard(
      {
        number: "4242 4242-4242 4242",
        expMonth: "12",
        expYear: "28",
        cvc: " 123 ",
        nameOnCard: "  Ada Lovelace  ",
      },
      NOW,
    );
    expect(r).toEqual({ ok: true, value: { ...validCard, last4: "4242" } });
  });

  test("Luhn boundary: 4242424242424242 passes, 4242424242424241 fails", () => {
    expect(validateCard(validCard, NOW).ok).toBe(true);
    expect(cardFieldCodes({ ...validCard, number: "4242424242424241" })).toEqual({
      number: "FAILED_CHECKSUM",
    });
  });

  test("length boundaries: 12 and 20 digits fail, 13 and 19 pass", () => {
    expect(cardFieldCodes({ ...validCard, number: "424242424242" })).toEqual({
      number: "INVALID_LENGTH",
    });
    expect(cardFieldCodes({ ...validCard, number: "42424242424242424242" })).toEqual({
      number: "INVALID_LENGTH",
    });
    expect(validateCard({ ...validCard, number: "4222222222222" }, NOW).ok).toBe(true); // 13
    expect(validateCard({ ...validCard, number: "4242424242424242428" }, NOW).ok).toBe(true); // 19
  });

  test("rejects non-digit characters", () => {
    for (const number of ["4242x24242424242", "4242.4242.4242.4242", "abcd"]) {
      expect(cardFieldCodes({ ...validCard, number })).toEqual({ number: "INVALID_CHARACTERS" });
    }
  });

  test("missing number", () => {
    for (const number of [undefined, "", "   ", 4242424242424242]) {
      expect(cardFieldCodes({ ...validCard, number })).toEqual({ number: "REQUIRED" });
    }
  });

  test("expiry boundary: this month passes, last month fails", () => {
    expect(validateCard({ ...validCard, expMonth: 11, expYear: 2026 }, NOW).ok).toBe(true);
    expect(cardFieldCodes({ ...validCard, expMonth: 10, expYear: 2026 })).toEqual({
      expMonth: "EXPIRED",
    });
    expect(cardFieldCodes({ ...validCard, expMonth: 12, expYear: 2025 })).toEqual({
      expMonth: "EXPIRED",
    });
  });

  test("expiry across a year boundary and on the last instant of the month", () => {
    const jan1 = new Date(Date.UTC(2027, 0, 1, 0, 0, 0));
    expect(cardFieldCodes({ ...validCard, expMonth: 12, expYear: 2026 }, jan1)).toEqual({
      expMonth: "EXPIRED",
    });
    const endOfNov = new Date(Date.UTC(2026, 10, 30, 23, 59, 59, 999));
    expect(validateCard({ ...validCard, expMonth: 11, expYear: 2026 }, endOfNov).ok).toBe(true);
  });

  test("month must be 1..12", () => {
    expect(validateCard({ ...validCard, expMonth: 1 }, NOW).ok).toBe(true);
    for (const expMonth of [0, 13, -1, 1.5, "ab", undefined]) {
      expect(cardFieldCodes({ ...validCard, expMonth })).toEqual({ expMonth: "INVALID_MONTH" });
    }
  });

  test("year must be exactly 2 or 4 digits", () => {
    for (const expYear of [28, "28", 2028, "2028"]) {
      expect(validateCard({ ...validCard, expYear }, NOW)).toEqual({
        ok: true,
        value: { ...validCard, last4: "4242" },
      });
    }
    for (const expYear of ["030", "202", "8", "20288", 202, 999, 10000, -28]) {
      expect(cardFieldCodes({ ...validCard, expYear })).toEqual({ expYear: "INVALID_YEAR" });
    }
  });

  test("all-identical digits are rejected even when Luhn-valid", () => {
    expect(luhnCheck("0000000000000")).toBe(true);
    for (const number of ["0000000000000", "0000 0000 0000 0000", "5555555555555555"]) {
      expect(cardFieldCodes({ ...validCard, number })).toEqual({ number: "FAILED_CHECKSUM" });
    }
  });

  test("raw cap: card string fields over 1,000 chars are TOO_LONG without echoing input", () => {
    const huge = "4".repeat(MAX_RAW_FIELD_LENGTH + 1);
    const t0 = performance.now();
    const r = validateCard(
      {
        number: " ".repeat(200_000) + VALID_NUMBER + " ".repeat(200_000),
        expMonth: "1".repeat(1001),
        expYear: "2".repeat(1001),
        cvc: huge,
        nameOnCard: " ".repeat(200_000) + "x",
      },
      NOW,
    );
    expect(performance.now() - t0).toBeLessThan(100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        Object.fromEntries(Object.entries(r.error.details.fields).map(([k, v]) => [k, v?.code])),
      ).toEqual({
        number: "TOO_LONG",
        expMonth: "TOO_LONG",
        expYear: "TOO_LONG",
        cvc: "TOO_LONG",
        nameOnCard: "TOO_LONG",
      });
      expect(JSON.stringify(r)).not.toContain(VALID_NUMBER);
    }
    // Exactly 1,000 chars is not capped; it falls through to the normal rules.
    expect(cardFieldCodes({ ...validCard, number: "4".repeat(1000) })).toEqual({
      number: "INVALID_LENGTH",
    });
  });

  test("invalid now is a programmer error (TypeError)", () => {
    expect(() => validateCard(validCard, new Date("invalid"))).toThrow(TypeError);
    expect(() => validateCard(validCard, "2026-11-15" as unknown as Date)).toThrow(TypeError);
  });

  test("year must be plausible", () => {
    expect(validateCard({ ...validCard, expYear: 2046 }, NOW).ok).toBe(true);
    for (const expYear of [2047, 1999, 2.5, "20x8", undefined]) {
      expect(cardFieldCodes({ ...validCard, expYear })).toEqual({ expYear: "INVALID_YEAR" });
    }
  });

  test("cvc must be 3 or 4 digits", () => {
    expect(validateCard({ ...validCard, cvc: "1234" }, NOW).ok).toBe(true);
    for (const cvc of ["12", "12345", "12a", "1 23"]) {
      expect(cardFieldCodes({ ...validCard, cvc })).toEqual({ cvc: "INVALID_CVC" });
    }
    for (const cvc of [undefined, "", "  ", 123]) {
      expect(cardFieldCodes({ ...validCard, cvc })).toEqual({ cvc: "REQUIRED" });
    }
  });

  test("name on card is required and trimmed", () => {
    for (const nameOnCard of ["", "   ", undefined]) {
      expect(cardFieldCodes({ ...validCard, nameOnCard })).toEqual({ nameOnCard: "REQUIRED" });
    }
  });

  test("non-object input reports every field", () => {
    expect(Object.keys(cardFieldCodes(null)).sort()).toEqual(
      ["cvc", "expMonth", "expYear", "nameOnCard", "number"],
    );
  });

  test("errors never contain the card number, its digits run, or the CVC", () => {
    const secrets = [
      { number: "4242424242424241", cvc: "987" }, // bad Luhn
      { number: "4242 4242 4242 4241", cvc: "9876" }, // bad Luhn, spaced
      { number: "42424242424242424242", cvc: "98" }, // too long, bad cvc
      { number: "4242x24242424242", cvc: "98a" }, // non-digit
    ];
    for (const { number, cvc } of secrets) {
      const r = validateCard({ ...validCard, number, cvc, expYear: 2020 }, NOW);
      expect(r.ok).toBe(false);
      const serialized = JSON.stringify(r);
      const digits = number.replace(/\D/g, "");
      expect(serialized).not.toContain(number);
      expect(serialized).not.toContain(digits);
      expect(serialized).not.toContain(digits.slice(0, 6)); // no BIN either
      expect(serialized).not.toContain(cvc);
    }
  });
});
