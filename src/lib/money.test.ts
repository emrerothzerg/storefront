import { describe, expect, test } from "bun:test";
import { addCents, formatMoney, isValidCents, multiplyCents, sumCents } from "./money";
import type { Result } from "./result";

const MAX = Number.MAX_SAFE_INTEGER;

function codeOf(r: Result<number>): string | undefined {
  return r.ok ? undefined : r.error.code;
}

describe("isValidCents", () => {
  test("accepts non-negative safe integers", () => {
    for (const v of [0, 1, 1999, MAX]) expect(isValidCents(v)).toBe(true);
  });
  test("rejects floats, negatives, unsafe, non-finite and non-numbers", () => {
    for (const v of [0.5, -1, MAX + 1, NaN, Infinity, -Infinity, "100", null, undefined]) {
      expect(isValidCents(v)).toBe(false);
    }
  });
});

describe("addCents", () => {
  test("adds integers", () => {
    expect(addCents(1999, 1)).toEqual({ ok: true, value: 2000 });
    expect(addCents(0, 0)).toEqual({ ok: true, value: 0 });
  });
  test("boundary: exactly MAX_SAFE_INTEGER is ok, one more overflows", () => {
    expect(addCents(MAX - 1, 1)).toEqual({ ok: true, value: MAX });
    expect(codeOf(addCents(MAX, 1))).toBe("MONEY_OVERFLOW");
    expect(codeOf(addCents(MAX, MAX))).toBe("MONEY_OVERFLOW");
  });
  test("rejects non-integers, negatives and NaN as INVALID_INPUT", () => {
    expect(codeOf(addCents(1.5, 1))).toBe("INVALID_INPUT");
    expect(codeOf(addCents(1, -1))).toBe("INVALID_INPUT");
    expect(codeOf(addCents(NaN, 1))).toBe("INVALID_INPUT");
    expect(codeOf(addCents(-Infinity, 1))).toBe("INVALID_INPUT");
  });
  test("unsafe or infinite inputs are MONEY_OVERFLOW", () => {
    expect(codeOf(addCents(MAX + 1, 0))).toBe("MONEY_OVERFLOW");
    expect(codeOf(addCents(Infinity, 0))).toBe("MONEY_OVERFLOW");
  });
});

describe("multiplyCents", () => {
  test("multiplies unit price by quantity", () => {
    expect(multiplyCents(1299, 3)).toEqual({ ok: true, value: 3897 });
    expect(multiplyCents(1299, 0)).toEqual({ ok: true, value: 0 });
    expect(multiplyCents(0, 5)).toEqual({ ok: true, value: 0 });
  });
  test("boundary around MAX_SAFE_INTEGER", () => {
    expect(multiplyCents(MAX, 1)).toEqual({ ok: true, value: MAX });
    expect(codeOf(multiplyCents(MAX, 2))).toBe("MONEY_OVERFLOW");
    const q = 1000;
    const unit = Math.floor(MAX / q);
    expect(multiplyCents(unit, q)).toEqual({ ok: true, value: unit * q });
    expect(codeOf(multiplyCents(unit + 1, q))).toBe("MONEY_OVERFLOW");
  });
  test("rejects non-integer price or quantity and negatives", () => {
    expect(codeOf(multiplyCents(19.99, 2))).toBe("INVALID_INPUT");
    expect(codeOf(multiplyCents(1999, 1.5))).toBe("INVALID_INPUT");
    expect(codeOf(multiplyCents(-1, 2))).toBe("INVALID_INPUT");
    expect(codeOf(multiplyCents(1, -2))).toBe("INVALID_INPUT");
  });
});

describe("negative zero", () => {
  test("ok values never carry -0", () => {
    for (const r of [
      addCents(-0, -0),
      addCents(-0, 0),
      multiplyCents(-0, 5),
      multiplyCents(5, -0),
      multiplyCents(-0, -0),
      sumCents([-0]),
      sumCents([-0, -0]),
    ]) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(Object.is(r.value, 0)).toBe(true);
    }
  });
});

describe("sumCents", () => {
  test("never throws: non-array input is INVALID_INPUT", () => {
    for (const bad of [null, undefined, "12", 12, {}, new Set([1]), { length: 1, 0: 1 }]) {
      const r = sumCents(bad as unknown as number[]);
      expect(codeOf(r)).toBe("INVALID_INPUT");
    }
  });
  test("sparse or mixed arrays are INVALID_INPUT", () => {
    expect(codeOf(sumCents([1, , 2] as number[]))).toBe("INVALID_INPUT");
    expect(codeOf(sumCents([1, "2"] as unknown as number[]))).toBe("INVALID_INPUT");
  });
  test("sums a list; empty list is 0", () => {
    expect(sumCents([100, 250, 1])).toEqual({ ok: true, value: 351 });
    expect(sumCents([])).toEqual({ ok: true, value: 0 });
  });
  test("overflow beyond MAX_SAFE_INTEGER", () => {
    expect(sumCents([MAX - 2, 1, 1])).toEqual({ ok: true, value: MAX });
    expect(codeOf(sumCents([MAX - 2, 1, 1, 1]))).toBe("MONEY_OVERFLOW");
  });
  test("reports the offending index for bad entries", () => {
    const r = sumCents([1, 2, 0.5]);
    expect(codeOf(r)).toBe("INVALID_INPUT");
    if (!r.ok) expect(r.error.details).toEqual({ operand: "amounts[2]" });
  });
});

// Ported from the removed src/lib/utils/formatPrice.test.ts.
describe("formatMoney", () => {
  test("formats USD cents", () => {
    expect(formatMoney(1999, "USD")).toBe("$19.99");
  });

  test("formats zero", () => {
    expect(formatMoney(0, "USD")).toBe("$0.00");
  });

  test("pads single-digit cents and keeps exact minor units", () => {
    expect(formatMoney(5, "USD")).toBe("$0.05");
    expect(formatMoney(100, "USD")).toBe("$1.00");
    expect(formatMoney(123456789, "USD")).toBe("$1,234,567.89");
  });

  test("rejects non-integer minor units instead of silently rounding", () => {
    expect(() => formatMoney(19.995, "USD")).toThrow(RangeError);
  });

  test("formats a non-USD currency with its own locale", () => {
    expect(formatMoney(1999, "EUR", "de-DE")).toBe("19,99 €");
    expect(formatMoney(1999, "GBP", "en-GB")).toBe("£19.99");
  });

  test("respects zero-decimal currencies", () => {
    expect(formatMoney(1999, "JPY", "en-US")).toBe("¥1,999");
    expect(formatMoney(1999, "JPY")).toBe("¥1,999");
  });

  test("exact for large safe integers (QA-T06-01)", () => {
    expect(formatMoney(MAX, "USD")).toBe("$90,071,992,547,409.91");
    expect(formatMoney(7079457843843082, "USD")).toBe("$70,794,578,438,430.82");
    expect(formatMoney(MAX, "JPY")).toBe("¥9,007,199,254,740,991");
    expect(formatMoney(MAX - 1, "KWD").replace(/\u00a0/g, " ")).toBe("KWD 9,007,199,254,740.990");
  });

  test("exact over a sweep of digit patterns", () => {
    const exact = (n: number): string => {
      const s = String(n).padStart(3, "0");
      return `$${BigInt(s.slice(0, -2)).toLocaleString("en-US")}.${s.slice(-2)}`;
    };
    // Deterministic 53-bit generator (64-bit LCG, top bits) so failures reproduce.
    const MUL = BigInt("6364136223846793005");
    const INC = BigInt("1442695040888963407");
    const MASK = BigInt("0xffffffffffffffff");
    const SHIFT = BigInt(11);
    let seed = BigInt("0x2545f4914f6cdd1d");
    const next = (): number => {
      seed = (seed * MUL + INC) & MASK;
      return Number(seed >> SHIFT);
    };
    for (let i = 0; i < 2000; i++) {
      const n = next() % (MAX + 1);
      expect(formatMoney(n, "USD")).toBe(exact(n));
    }
    for (let p = 1; p <= MAX; p *= 10) {
      for (const n of [p - 1, p, p + 1]) {
        if (n <= MAX) expect(formatMoney(n, "USD")).toBe(exact(n));
      }
    }
  });

  test("three-decimal currencies keep all minor digits", () => {
    expect(formatMoney(1, "KWD", "en-US").replace(/\u00a0/g, " ")).toBe("KWD 0.001");
    expect(formatMoney(12345, "KWD", "en-US").replace(/\u00a0/g, " ")).toBe("KWD 12.345");
  });

  test("-0 formats as zero", () => {
    expect(formatMoney(-0, "USD")).toBe("$0.00");
  });

  test("rejects negative and unsafe integers with RangeError", () => {
    for (const n of [-1, -5, MAX + 1, 1e21, -MAX]) {
      expect(() => formatMoney(n, "USD")).toThrow(RangeError);
    }
    expect(() => formatMoney(NaN, "USD")).toThrow(RangeError);
    expect(() => formatMoney(Infinity, "USD")).toThrow(RangeError);
  });

  test("rejects an invalid currency code", () => {
    expect(() => formatMoney(100, "US")).toThrow(RangeError);
  });
});
