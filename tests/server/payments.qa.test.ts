/**
 * QA adversarial tests for T10 (PaymentProvider + MockPaymentProvider).
 * Cards are built with `validateCard` from `@/lib/validation` (fixed `now`) to
 * prove the ValidatedCard contract lines up with the provider.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PaymentFailureCode } from "@/lib/types";
import { luhnCheck, validateCard, type ValidatedCard } from "@/lib/validation";
import {
  MOCK_CARDS,
  MockPaymentProvider,
  PAYMENT_FAILURE_MESSAGES,
  createMockPaymentProvider,
  type PaymentLogEvent,
} from "@/server/payments/mock-payment-provider";
import type { ChargeRequest, PaymentProvider, PaymentResult } from "@/server/payments/payment-provider";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const CVC = "737";
const NAME = "Grace Hopper";

function card(number: string, extra: Partial<Record<string, unknown>> = {}): ValidatedCard {
  const r = validateCard({ number, expMonth: 12, expYear: 2030, cvc: CVC, nameOnCard: NAME, ...extra }, NOW);
  if (!r.ok) throw new Error(`validateCard rejected test card: ${JSON.stringify(r.error.details.fields)}`);
  return r.value;
}

function req(number: string, idempotencyKey: string, overrides: Partial<ChargeRequest> = {}): ChargeRequest {
  return { amountCents: 2500, currency: "USD", card: card(number), idempotencyKey, ...overrides };
}

function outcome(r: PaymentResult): "success" | PaymentFailureCode {
  return r.ok ? "success" : r.error.code;
}

/** Digit-free ids so a /\d{6,}/ scan is meaningful. */
function letterIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `ref${"abcdefghij"[n % 10]}${"klmnopqrst"[Math.floor(n / 10) % 10]}`;
  };
}

/** Digit-free idempotency keys. */
function letterKey(i: number): string {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n > 0);
  return `key-${s}`;
}

// 19-digit Luhn-valid number: append a check digit.
function withCheckDigit(body: string): string {
  for (let d = 0; d <= 9; d++) if (luhnCheck(body + d)) return body + d;
  throw new Error("unreachable");
}
const NINETEEN = withCheckDigit("601100000000000000"); // 18 + 1
const OTHER_VALID = ["5555555555554444", "378282246310005", "6011111111111117", NINETEEN];

describe("QA T10 AC1: magic cards are deterministic (100x each, via validateCard)", () => {
  const cases: ReadonlyArray<readonly [string, "success" | PaymentFailureCode]> = [
    ["4242424242424242", "success"],
    ["4000000000000002", "DECLINED"],
    ["4000000000009995", "INSUFFICIENT_FUNDS"],
    ["4000000000000119", "PROCESSING_ERROR"],
    ...OTHER_VALID.map((n) => [n, "success"] as const),
  ];
  for (const [number, expected] of cases) {
    test(`${number} -> ${expected} x100, fresh key each time`, async () => {
      const p = new MockPaymentProvider();
      const results: PaymentResult[] = [];
      for (let i = 0; i < 100; i++) results.push(await p.charge(req(number, `k${i}`)));
      expect(results.every((r) => outcome(r) === expected)).toBe(true);
      expect(p.listCharges()).toHaveLength(100);
      if (expected !== "success") {
        for (const r of results) expect(r).toEqual({ ok: false, error: { code: expected, message: PAYMENT_FAILURE_MESSAGES[expected] } });
      } else {
        for (const r of results) if (r.ok) expect(r.value.last4).toBe(number.slice(-4));
      }
    });
  }

  test("MOCK_CARDS constants match the spec literals", () => {
    expect(MOCK_CARDS).toEqual({
      success: "4242424242424242",
      declined: "4000000000000002",
      insufficientFunds: "4000000000009995",
      processingError: "4000000000000119",
    });
  });

  test("19-digit Luhn-valid card: accepted by validateCard and charged successfully", async () => {
    expect(NINETEEN).toHaveLength(19);
    const c = card(NINETEEN);
    expect(c.number).toBe(NINETEEN);
    const r = await new MockPaymentProvider().charge(req(NINETEEN, "nineteen"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.last4).toBe(NINETEEN.slice(-4));
  });

  test("card numbers with spaces / dashes resolve to the same magic outcome", async () => {
    const p = new MockPaymentProvider();
    const spaced = card("4000 0000 0000 0002");
    expect(spaced.number).toBe("4000000000000002");
    expect(outcome(await p.charge({ ...req("4242424242424242", "s1"), card: spaced }))).toBe("DECLINED");
    expect(outcome(await p.charge({ ...req("4242424242424242", "s2"), card: card("4000-0000-0000-9995") }))).toBe("INSUFFICIENT_FUNDS");
    expect(outcome(await p.charge({ ...req("4242424242424242", "s3"), card: card(" 4000 0000 0000 0119 ") }))).toBe("PROCESSING_ERROR");
    // Hand-built (unnormalized) card with spaces still hits the magic table.
    const raw: ValidatedCard = { ...spaced, number: "4000 0000 0000 0002", last4: "0002" };
    expect(outcome(await p.charge({ ...req("4242424242424242", "s4"), card: raw }))).toBe("DECLINED");
  });

  test("provider derives last4 from the number, not the (possibly forged) card.last4", async () => {
    const forged: ValidatedCard = { ...card("4242424242424242"), last4: "9999" };
    const r = await new MockPaymentProvider().charge({ ...req("4242424242424242", "forged"), card: forged });
    expect(r.ok && r.value.last4).toBe("4242");
  });
});

describe("QA T10 AC2: idempotency", () => {
  test("50 concurrent calls, same key, different cards: one recorded charge, all results deep-equal and identical", async () => {
    const p = new MockPaymentProvider();
    const cards = ["4242424242424242", "4000000000000002", "4000000000009995", "4000000000000119", ...OTHER_VALID];
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => p.charge(req(cards[i % cards.length] ?? "4242424242424242", "same-key", { amountCents: 100 + i }))),
    );
    expect(p.listCharges()).toHaveLength(1);
    const first = results[0] as PaymentResult;
    for (const r of results) {
      expect(r).toEqual(first);
      expect(r).toBe(first);
    }
    expect(outcome(first)).toBe("success"); // first request (4242, 100c) wins
    expect(p.listCharges()[0]?.amountCents).toBe(100);
    expect(p.listCharges()[0]?.last4).toBe("4242");
  });

  test("50 concurrent calls with latencyMs: 5, same key, different cards: one charge", async () => {
    const p = new MockPaymentProvider({ latencyMs: 5 });
    const cards = ["4000000000000002", "4242424242424242", "4000000000009995"];
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => p.charge(req(cards[i % 3] ?? "4242424242424242", "slow-key"))),
    );
    expect(p.listCharges()).toHaveLength(1);
    expect(new Set(results).size).toBe(1);
    expect(outcome(results[0] as PaymentResult)).toBe("DECLINED");
  });

  test("latencyMs: 5 with 50 distinct keys concurrently: 50 charges, one per key", async () => {
    const p = new MockPaymentProvider({ latencyMs: 5 });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => p.charge(req("4242424242424242", `d${i}`))));
    expect(results.every((r) => r.ok)).toBe(true);
    const charges = p.listCharges();
    expect(charges).toHaveLength(50);
    expect(new Set(charges.map((c) => c.idempotencyKey)).size).toBe(50);
    expect(new Set(results.map((r) => (r.ok ? r.value.providerRef : ""))).size).toBe(50);
  });

  test("mixed: 10 keys x 10 concurrent calls with latency -> 10 charges", async () => {
    const p = new MockPaymentProvider({ latencyMs: 5 });
    await Promise.all(Array.from({ length: 100 }, (_, i) => p.charge(req("4242424242424242", `m${i % 10}`))));
    expect(p.listCharges()).toHaveLength(10);
  });

  test("sequential replay after settle returns the identical frozen object", async () => {
    const p = new MockPaymentProvider();
    const a = await p.charge(req("4242424242424242", "seq"));
    const b = await p.charge(req("4242424242424242", "seq"));
    expect(b).toBe(a);
    expect(p.listCharges()).toHaveLength(1);
  });

  test("same key reused after reset() charges again", async () => {
    const p = new MockPaymentProvider();
    const a = await p.charge(req("4242424242424242", "reuse"));
    p.reset();
    const b = await p.charge(req("4242424242424242", "reuse"));
    expect(b).not.toBe(a);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.value.providerRef).not.toBe(a.value.providerRef);
    expect(p.listCharges()).toHaveLength(1);
    expect(p.listCharges()[0]?.providerRef).toBe(b.ok ? b.value.providerRef : "");
  });

  test("reset() during an in-flight charge, then same key: new charge recorded, old one not", async () => {
    const p = new MockPaymentProvider({ latencyMs: 5 });
    const inflight = p.charge(req("4000000000000002", "race"));
    p.reset();
    const fresh = p.charge(req("4242424242424242", "race"));
    const [a, b] = await Promise.all([inflight, fresh]);
    expect(outcome(a)).toBe("DECLINED");
    expect(outcome(b)).toBe("success");
    expect(p.listCharges().map((c) => c.outcome)).toEqual(["success"]);
  });

  test("keys are not shared between provider instances", async () => {
    const a = new MockPaymentProvider();
    const b = new MockPaymentProvider();
    await a.charge(req("4242424242424242", "shared"));
    await b.charge(req("4242424242424242", "shared"));
    expect(a.listCharges()).toHaveLength(1);
    expect(b.listCharges()).toHaveLength(1);
  });
});

describe("QA T10 AC3: amount validation", () => {
  test("1e3 is a valid integer amount and charges", async () => {
    const p = new MockPaymentProvider();
    const r = await p.charge(req("4242424242424242", "e3", { amountCents: 1e3 }));
    expect(r.ok).toBe(true);
    expect(p.listCharges()[0]?.amountCents).toBe(1000);
  });

  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ["0", 0],
    ["-0", -0],
    ["-1", -1],
    ["-1e3", -1e3],
    ["0.1", 0.1],
    ["999.999", 999.999],
    ["1e21 (integer-valued but unsafe)", 1e21],
    ["MAX_SAFE_INTEGER + 2", Number.MAX_SAFE_INTEGER + 2],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["string '1000'", "1000"],
    ["bigint 1000n", BigInt(1000)],
    ["null", null],
    ["undefined", undefined],
    ["Number object", new Number(1000)],
  ];
  for (const [label, amount] of bad) {
    test(`${label} -> INVALID_AMOUNT, nothing recorded, no settle log`, async () => {
      const logs: PaymentLogEvent[] = [];
      const p = new MockPaymentProvider({ logger: (e) => logs.push(e) });
      const r = await p.charge({ ...req("4242424242424242", `bad-${label}`), amountCents: amount as number });
      expect(r).toEqual({ ok: false, error: { code: "INVALID_AMOUNT", message: "The payment amount is invalid." } });
      expect(p.listCharges()).toHaveLength(0);
      expect(logs.some((e) => e.event === "charge.settled")).toBe(false);
    });
  }

  test("INVALID_AMOUNT is checked even for magic decline cards (no charge)", async () => {
    const p = new MockPaymentProvider();
    const r = await p.charge(req("4000000000000002", "bad-decline", { amountCents: 0 }));
    expect(outcome(r)).toBe("INVALID_AMOUNT");
    expect(p.listCharges()).toHaveLength(0);
  });

  test("observed: amount 0 on a key that already charged replays the cached success (first request wins)", async () => {
    const p = new MockPaymentProvider();
    const first = await p.charge(req("4242424242424242", "zero-after"));
    const second = await p.charge(req("4242424242424242", "zero-after", { amountCents: 0 }));
    expect(second).toBe(first);
    expect(p.listCharges()).toHaveLength(1);
  });
});

describe("QA T10 AC4: failure shape and frozen results", () => {
  test("every failure has a stable code and a fixed user-safe message", async () => {
    const p = new MockPaymentProvider();
    for (const [n, code] of [
      ["4000000000000002", "DECLINED"],
      ["4000000000009995", "INSUFFICIENT_FUNDS"],
      ["4000000000000119", "PROCESSING_ERROR"],
    ] as const) {
      const r = await p.charge(req(n, `f-${code}`));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(Object.keys(r.error).sort()).toEqual(["code", "message"]);
        expect(r.error.code).toBe(code);
        expect(r.error.message).toBe(PAYMENT_FAILURE_MESSAGES[code]);
        expect(r.error.message).not.toMatch(/\d/);
      }
    }
  });

  test("Object.isFrozen holds for result, value/error, listCharges() and each entry", async () => {
    const p = new MockPaymentProvider();
    const ok = await p.charge(req("4242424242424242", "fz1"));
    const ko = await p.charge(req("4000000000000002", "fz2"));
    const inv = await p.charge(req("4242424242424242", "fz3", { amountCents: -5 }));
    for (const r of [ok, ko, inv]) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.ok ? r.value : r.error)).toBe(true);
    }
    const list = p.listCharges();
    expect(Object.isFrozen(list)).toBe(true);
    for (const c of list) expect(Object.isFrozen(c)).toBe(true);
  });

  test("mutating a frozen result throws in strict mode and does not corrupt the replay", async () => {
    const p = new MockPaymentProvider();
    const r = await p.charge(req("4242424242424242", "mut"));
    expect(() => {
      (r as { ok: boolean }).ok = false;
    }).toThrow(TypeError);
    if (r.ok) {
      expect(() => {
        (r.value as { last4: string }).last4 = "0000";
      }).toThrow(TypeError);
    }
    const replay = await p.charge(req("4242424242424242", "mut"));
    expect(replay.ok && replay.value.last4).toBe("4242");
  });
});

describe("QA T10 AC4: leak scan", () => {
  test("results, listCharges() and logger output contain no 6+ digit run, CVC or name", async () => {
    const logs: PaymentLogEvent[] = [];
    const logText: string[] = [];
    const p = new MockPaymentProvider({
      idGenerator: letterIds(),
      now: () => NOW,
      logger: (e) => {
        logs.push(e);
        logText.push(JSON.stringify(e), String(e), Bun.inspect(e));
      },
    });
    const numbers = [
      "4242424242424242",
      "4000000000000002",
      "4000000000009995",
      "4000000000000119",
      ...OTHER_VALID,
      "4242 4242 4242 4242",
    ];
    const blobs: string[] = [];
    let i = 0;
    for (const n of numbers) {
      const key = letterKey(i++);
      blobs.push(JSON.stringify(await p.charge(req(n, key)))); // first
      blobs.push(JSON.stringify(await p.charge(req(n, key)))); // replay
      blobs.push(JSON.stringify(await p.charge(req(n, letterKey(1000 + i), { amountCents: 0 })))); // invalid
      blobs.push(JSON.stringify(await p.charge(req(n, letterKey(2000 + i), { amountCents: 1e21 })))); // invalid
    }
    // concurrent same-key with different cards
    await Promise.all(numbers.map((n) => p.charge(req(n, "key-concurrent"))).map((pr) => pr.then((r) => blobs.push(JSON.stringify(r)))));
    blobs.push(JSON.stringify(p.listCharges()));
    blobs.push(Bun.inspect(p.listCharges()));
    blobs.push(...logText);
    expect(logs.length).toBeGreaterThan(numbers.length * 3);

    // Positive control: the scan sees real payloads (last4 present, regex can match).
    expect(blobs.join("\n")).toContain('"last4":"4242"');
    expect(JSON.stringify(card("4242424242424242"))).toMatch(/\d{6,}/);
    const allDigitsOfCards = numbers.map((n) => n.replace(/\D/g, ""));
    for (const text of blobs) {
      expect(text).not.toMatch(/\d{6,}/);
      expect(text).not.toContain(CVC);
      expect(text).not.toContain("Grace");
      expect(text).not.toContain("Hopper");
      expect(text).not.toMatch(/cvc|expMonth|expYear|nameOnCard|"number"/i);
      for (const d of allDigitsOfCards) expect(text).not.toContain(d.slice(0, 6)); // BIN
    }
  });

  test("the provider instance itself retains no full card number, CVC or name (Bun.inspect)", async () => {
    const p = new MockPaymentProvider({ idGenerator: letterIds() });
    await p.charge(req("5555555555554444", "inspect-a"));
    await p.charge(req("4000000000000002", "inspect-b"));
    const dump = Bun.inspect(p, { depth: 10 });
    expect(dump).not.toContain("5555555555554444");
    expect(dump).not.toContain("555555");
    expect(dump).not.toContain(CVC);
    expect(dump).not.toContain(NAME);
  });

  test("no console output on any path", async () => {
    const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
    const saved = methods.map((m) => console[m]);
    let calls = 0;
    for (const m of methods) console[m] = () => void (calls += 1);
    try {
      const p = new MockPaymentProvider({ latencyMs: 1 });
      await Promise.all([
        p.charge(req("4242424242424242", "c1")),
        p.charge(req("4242424242424242", "c1")),
        p.charge(req("4000000000000119", "c2")),
        p.charge(req("4242424242424242", "c3", { amountCents: 0 })),
      ]);
    } finally {
      methods.forEach((m, idx) => {
        console[m] = saved[idx] as (typeof console)[typeof m];
      });
    }
    expect(calls).toBe(0);
  });
});

describe("QA T10 AC5/AC6: injection, no network, no deps", () => {
  const dir = join(import.meta.dir, "../../src/server/payments");
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

  test("no module-level provider instance or default export in src/server/payments", () => {
    for (const [, src] of sources) {
      expect(src).not.toMatch(/export default/);
      // `new MockPaymentProvider` only inside the factory function body
      const lines = src.split("\n").filter((l) => /new MockPaymentProvider/.test(l));
      for (const l of lines) expect(l.startsWith(" ")).toBe(true);
    }
  });

  test("imports only @/lib/* and local modules (no third-party, no node:http/net)", () => {
    for (const [, src] of sources) {
      const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
      for (const s of specs) expect(s.startsWith("@/lib/") || s.startsWith("./")).toBe(true);
      expect(src).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|node:http|node:net|require\(/);
    }
  });

  test("charge works with fetch disabled (no network access)", async () => {
    const realFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (() => {
      fetched = true;
      throw new Error("network");
    }) as unknown as typeof fetch;
    try {
      const injected: PaymentProvider = createMockPaymentProvider({ latencyMs: 1 });
      expect((await injected.charge(req("4242424242424242", "net"))).ok).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(false);
  });

  test("factory returns independent instances", () => {
    expect(createMockPaymentProvider()).not.toBe(createMockPaymentProvider());
  });
});
