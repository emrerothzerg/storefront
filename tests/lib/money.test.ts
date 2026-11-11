/**
 * QA adversarial suite for src/lib/money.ts (T06, criteria 1 and 7).
 * Independent of the author's colocated tests.
 */
import { describe, expect, test } from "bun:test";
import { addCents, formatMoney, isValidCents, multiplyCents, sumCents } from "@/lib/money";
import type { Result } from "@/lib/result";

const MAX = Number.MAX_SAFE_INTEGER;
const MAX_BIG = BigInt(MAX);

/** Values that must never be accepted as a money operand. */
const HOSTILE: ReadonlyArray<readonly [string, unknown]> = [
  ["0.1 + 0.2", 0.1 + 0.2],
  ["0.5", 0.5],
  ["-1", -1],
  ["-0.5", -0.5],
  ["NaN", Number.NaN],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["numeric string", "100"],
  ["BigInt-like string", "9007199254740993"],
  ["bigint", BigInt(5)],
  ["object with valueOf", { valueOf: () => 5 }],
  ["Number object", new Number(5)],
  ["array [5]", [5]],
  ["empty array", []],
  ["null", null],
  ["undefined", undefined],
  ["prototype-less object", Object.create(null)],
  ["boolean true", true],
  ["very long digit string", "9".repeat(10_000)],
];

/** Integer but not safe: must be MONEY_OVERFLOW. */
const UNSAFE: ReadonlyArray<readonly [string, number]> = [
  ["MAX_SAFE_INTEGER + 1", MAX + 1],
  ["MAX_SAFE_INTEGER + 2", MAX + 2],
  ["1e21", 1e21],
  ["Number.MAX_VALUE", Number.MAX_VALUE],
  ["Infinity", Number.POSITIVE_INFINITY],
];

const asNum = (v: unknown) => v as number;

function expectErr(r: Result<number>, code: "INVALID_INPUT" | "MONEY_OVERFLOW") {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
}

function expectOk(r: Result<number>, value: number) {
  expect(r).toEqual({ ok: true, value });
  if (r.ok) expect(Number.isSafeInteger(r.value)).toBe(true);
}

describe("isValidCents", () => {
  test("boundaries", () => {
    expect(isValidCents(0)).toBe(true);
    expect(isValidCents(MAX)).toBe(true);
    expect(isValidCents(MAX + 1)).toBe(false);
    expect(isValidCents(-1)).toBe(false);
  });
  test.each(HOSTILE)("rejects %s", (_label, v) => {
    expect(isValidCents(v)).toBe(false);
  });
});

describe("addCents", () => {
  test("boundary at MAX_SAFE_INTEGER", () => {
    expectOk(addCents(MAX, 0), MAX);
    expectOk(addCents(0, MAX), MAX);
    expectOk(addCents(MAX - 1, 1), MAX);
    expectErr(addCents(MAX, 1), "MONEY_OVERFLOW");
    expectErr(addCents(1, MAX), "MONEY_OVERFLOW");
    expectErr(addCents(MAX, MAX), "MONEY_OVERFLOW");
  });
  test.each(HOSTILE)("hostile operand %s -> INVALID_INPUT (either position)", (_l, v) => {
    expectErr(addCents(asNum(v), 1), "INVALID_INPUT");
    expectErr(addCents(1, asNum(v)), "INVALID_INPUT");
  });
  test.each(UNSAFE)("unsafe operand %s -> MONEY_OVERFLOW", (_l, v) => {
    expectErr(addCents(v, 0), "MONEY_OVERFLOW");
    expectErr(addCents(0, v), "MONEY_OVERFLOW");
  });
});

describe("multiplyCents", () => {
  test("boundary at MAX_SAFE_INTEGER", () => {
    expectOk(multiplyCents(MAX, 1), MAX);
    expectOk(multiplyCents(1, MAX), MAX);
    expectOk(multiplyCents(MAX, 0), 0);
    expectOk(multiplyCents(0, MAX), 0);
    // MAX = 2^53 - 1 = 3 * 3002399751580330.33..., floor gives the largest safe unit
    const unit = Math.floor(MAX / 3);
    expectOk(multiplyCents(unit, 3), unit * 3);
    expectErr(multiplyCents(unit + 1, 3), "MONEY_OVERFLOW");
    expectErr(multiplyCents(MAX, 2), "MONEY_OVERFLOW");
    expectErr(multiplyCents(2 ** 27, 2 ** 26), "MONEY_OVERFLOW"); // exactly 2^53
    expectOk(multiplyCents(2 ** 26, 2 ** 26), 2 ** 52);
  });
  test("result is exact against BigInt near the limit", () => {
    const r = multiplyCents(94906265, 94906265); // 94906265^2 = 9007199136250225 <= MAX
    expect(r.ok).toBe(true);
    if (r.ok) expect(BigInt(r.value)).toBe(BigInt(94906265) * BigInt(94906265));
    expectErr(multiplyCents(94906266, 94906266), "MONEY_OVERFLOW");
  });
  test.each(HOSTILE)("hostile operand %s -> INVALID_INPUT (either position)", (_l, v) => {
    expectErr(multiplyCents(asNum(v), 2), "INVALID_INPUT");
    expectErr(multiplyCents(2, asNum(v)), "INVALID_INPUT");
  });
  test.each(UNSAFE)("unsafe operand %s -> MONEY_OVERFLOW even when other side is 0", (_l, v) => {
    expectErr(multiplyCents(v, 0), "MONEY_OVERFLOW");
    expectErr(multiplyCents(0, v), "MONEY_OVERFLOW");
  });
});

describe("sumCents", () => {
  test("empty and boundary", () => {
    expectOk(sumCents([]), 0);
    expectOk(sumCents([MAX]), MAX);
    expectOk(sumCents([MAX - 2, 1, 1]), MAX);
    expectErr(sumCents([MAX - 2, 1, 1, 1]), "MONEY_OVERFLOW");
    expectErr(sumCents([MAX, MAX]), "MONEY_OVERFLOW");
  });
  test("many small floats never sum to an ok float", () => {
    expectErr(sumCents([0.1, 0.2]), "INVALID_INPUT");
  });
  test("sparse array hole is INVALID_INPUT", () => {
    const holey = [1, 2, 3];
    delete holey[1];
    expectErr(sumCents(holey), "INVALID_INPUT");
  });
  test.each(HOSTILE)("hostile element %s -> INVALID_INPUT with index", (_l, v) => {
    const r = sumCents([1, asNum(v)]);
    expectErr(r, "INVALID_INPUT");
    if (!r.ok) expect(r.error.details).toEqual({ operand: "amounts[1]" });
  });
  test.each(UNSAFE)("unsafe element %s -> MONEY_OVERFLOW", (_l, v) => {
    expectErr(sumCents([0, v]), "MONEY_OVERFLOW");
  });
});

describe("property: ok values are always safe integers equal to the exact BigInt result (200 iterations each)", () => {
  // Deterministic PRNG (mulberry32) so failures are reproducible.
  function rng(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gen(r: () => number): number {
    const k = Math.floor(r() * 9);
    switch (k) {
      case 0: return Math.floor(r() * 10_000);
      case 1: return MAX - Math.floor(r() * 1000);
      case 2: return Math.floor(r() * MAX);
      case 3: return r() * 1000; // float
      case 4: return -Math.floor(r() * 1000) - 1;
      case 5: return Math.floor(Math.sqrt(MAX) * (0.9 + r() * 0.2));
      case 6: return MAX + Math.floor(r() * 10);
      case 7: return 0;
      default: return [Number.NaN, Number.POSITIVE_INFINITY, -0, 0.1 + 0.2][Math.floor(r() * 4)] ?? 0;
    }
  }
  const valid = (n: number) => Number.isSafeInteger(n) && n >= 0;

  function check(r: Result<number>, operands: readonly number[], exact: () => bigint) {
    if (r.ok) {
      expect(Number.isSafeInteger(r.value)).toBe(true);
      expect(r.value >= 0).toBe(true);
      expect(Object.is(r.value, -0)).toBe(false);
      expect(BigInt(r.value)).toBe(exact());
    } else {
      expect(["INVALID_INPUT", "MONEY_OVERFLOW"]).toContain(r.error.code);
      if (operands.every(valid)) {
        expect(r.error.code).toBe("MONEY_OVERFLOW");
        expect(exact() > MAX_BIG).toBe(true);
      }
    }
  }

  test("addCents", () => {
    const r = rng(1);
    for (let i = 0; i < 200; i++) {
      const a = gen(r), b = gen(r);
      check(addCents(a, b), [a, b], () => BigInt(a) + BigInt(b));
    }
  });
  test("multiplyCents", () => {
    const r = rng(2);
    for (let i = 0; i < 200; i++) {
      const a = gen(r), b = gen(r);
      check(multiplyCents(a, b), [a, b], () => BigInt(a) * BigInt(b));
    }
  });
  test("sumCents", () => {
    const r = rng(3);
    for (let i = 0; i < 200; i++) {
      const xs = Array.from({ length: 1 + Math.floor(r() * 5) }, () => gen(r));
      check(sumCents(xs), xs, () => xs.reduce((s, x) => s + BigInt(x), BigInt(0)));
    }
  });
});

describe("serializability", () => {
  test.each([
    ["addCents ok", addCents(1, 2)],
    ["addCents INVALID_INPUT", addCents(0.5, 1)],
    ["addCents MONEY_OVERFLOW", addCents(MAX, 1)],
    ["multiplyCents ok", multiplyCents(199, 3)],
    ["multiplyCents overflow", multiplyCents(MAX, 2)],
    ["sumCents ok", sumCents([1, 2, 3])],
    ["sumCents invalid", sumCents([1, Number.NaN])],
  ])("%s survives JSON round trip", (_l, r) => {
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

describe("formatMoney", () => {
  test("basic and minor-unit currencies", () => {
    expect(formatMoney(0, "USD")).toBe("$0.00");
    expect(formatMoney(1, "USD")).toBe("$0.01");
    expect(formatMoney(1999, "JPY")).toBe("¥1,999");
    expect(formatMoney(1234, "BHD")).toContain("1.234"); // 3-decimal currency
  });
  test.each([
    ["0.1 + 0.2", 0.1 + 0.2],
    ["0.5", 0.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("throws RangeError on non-integer %s (accepted behaviour)", (_l, v) => {
    expect(() => formatMoney(v, "USD")).toThrow(RangeError);
  });
  test("throws on invalid currency", () => {
    expect(() => formatMoney(100, "US")).toThrow(RangeError);
  });

  /** Exact expected en-US USD string computed with BigInt (no floats). */
  function exactUsd(n: number): string {
    const s = BigInt(n).toString().padStart(3, "0");
    return `$${BigInt(s.slice(0, -2)).toLocaleString("en-US")}.${s.slice(-2)}`;
  }

  test("formats realistic amounts exactly", () => {
    for (const n of [99, 100, 1999, 123456789, 99_999_999_999]) {
      expect(formatMoney(n, "USD")).toBe(exactUsd(n));
    }
  });

  // Regression test for QA-T06-01 (fixed): float division used to lose the last cent.
  test("formats every safe integer exactly, including MAX_SAFE_INTEGER", () => {
    expect(formatMoney(7079457843843082, "USD")).toBe(exactUsd(7079457843843082));
    expect(formatMoney(MAX, "USD")).toBe(exactUsd(MAX)); // $90,071,992,547,409.91
  });
});

describe("orchestrator rulings (post QA-T06-01)", () => {
  test("ruling 1: -0 is normalised to 0 in every ok value", () => {
    const results = [
      addCents(-0, 0),
      addCents(0, -0),
      addCents(-0, -0),
      addCents(-0, 7),
      multiplyCents(-0, 5),
      multiplyCents(5, -0),
      multiplyCents(-0, -0),
      multiplyCents(-0, 0),
      sumCents([-0]),
      sumCents([-0, -0]),
      sumCents([-0, 3]),
    ];
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(Object.is(r.value, -0)).toBe(false);
    }
    const m = multiplyCents(-0, 5);
    expect(m.ok && Object.is(m.value, 0)).toBe(true);
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "12"],
    ["object", {}],
    ["array-like object", { length: 2, 0: 1, 1: 2 }],
    ["number", 5],
    ["Set", new Set([1, 2])],
    ["typed array", new Uint8Array([1, 2])],
  ])("ruling 2: sumCents(%s) never throws, returns INVALID_INPUT", (_l, v) => {
    let r: Result<number> | undefined;
    expect(() => {
      r = sumCents(v as unknown as number[]);
    }).not.toThrow();
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });

  test("ruling 2: sparse arrays are INVALID_INPUT (new Array(3), trailing hole)", () => {
    expectErr(sumCents(new Array<number>(3)), "INVALID_INPUT");
    const trailing = [1, 2];
    trailing.length = 3;
    expectErr(sumCents(trailing), "INVALID_INPUT");
  });

  test.each([
    ["-1", -1],
    ["-5", -5],
    ["MIN_SAFE_INTEGER", Number.MIN_SAFE_INTEGER],
    ["MAX_SAFE_INTEGER + 1", MAX + 1],
    ["1e21", 1e21],
    ["-1e21", -1e21],
    ["Number.MAX_VALUE", Number.MAX_VALUE],
  ])("ruling 3: formatMoney throws RangeError for negative/unsafe %s", (_l, v) => {
    expect(() => formatMoney(v, "USD")).toThrow(RangeError);
  });

  test("ruling 3: -0 formats as $0.00; MAX_SAFE_INTEGER still formats", () => {
    expect(formatMoney(-0, "USD")).toBe("$0.00");
    expect(formatMoney(-0, "JPY")).toBe("¥0");
    expect(formatMoney(MAX, "USD")).toBe("$90,071,992,547,409.91");
  });

  test("formatMoney stays exact across currencies and locales", () => {
    expect(formatMoney(MAX, "JPY")).toBe("¥9,007,199,254,740,991");
    expect(formatMoney(5, "BHD")).toContain("0.005");
    expect(formatMoney(MAX, "BHD")).toContain("9,007,199,254,740.991");
    expect(formatMoney(MAX, "EUR", "de-DE").replace(/\s/g, " ")).toBe("90.071.992.547.409,91 €");
    expect(formatMoney(7, "USD")).toBe("$0.07");
  });

  test("property: formatMoney is exact for 200 random large safe integers", () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 200; i++) {
      const n = Math.floor(next() * MAX);
      const s = BigInt(n).toString().padStart(3, "0");
      expect(formatMoney(n, "USD")).toBe(`$${BigInt(s.slice(0, -2)).toLocaleString("en-US")}.${s.slice(-2)}`);
    }
  });
});
