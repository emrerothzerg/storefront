import { describe, expect, test } from "bun:test";
import type { PaymentFailureCode } from "@/lib/types";
import { validateCard, type ValidatedCard } from "@/lib/validation";
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MOCK_CARDS,
  MockPaymentProvider,
  PAYMENT_FAILURE_MESSAGES,
  createMockPaymentProvider,
  type PaymentLogEvent,
} from "./mock-payment-provider";
import type { ChargeRequest, PaymentProvider, PaymentResult } from "./payment-provider";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const CVC = "737";

/** Bypasses validation, for the defensive non-Luhn path. */
function rawCard(number: string): ValidatedCard {
  return { number, expMonth: 12, expYear: 2030, cvc: CVC, nameOnCard: "Ada Lovelace", last4: number.slice(-4) };
}

let keyCounter = 0;
function request(number: string, overrides: Partial<ChargeRequest> = {}): ChargeRequest {
  keyCounter += 1;
  return {
    amountCents: 1999,
    currency: "USD",
    card: luhnSafeCard(number),
    idempotencyKey: `key-${keyCounter}`,
    ...overrides,
  };
}

/** Validated card when the number passes validation, raw otherwise (non-Luhn path). */
function luhnSafeCard(number: string): ValidatedCard {
  const validated = validateCard({ number, expMonth: 12, expYear: 2030, cvc: CVC, nameOnCard: "Ada Lovelace" }, NOW);
  return validated.ok ? validated.value : rawCard(number);
}

function provider(logger?: (e: PaymentLogEvent) => void): MockPaymentProvider {
  let n = 0;
  return new MockPaymentProvider({
    now: () => NOW,
    idGenerator: () => `id${++n}`,
    ...(logger ? { logger } : {}),
  });
}

function outcomeOf(result: PaymentResult): "success" | PaymentFailureCode {
  return result.ok ? "success" : result.error.code;
}

const OTHER_VALID = "5555555555554444";
const NON_LUHN = "4242424242424241";

describe("MockPaymentProvider outcomes", () => {
  const cases: ReadonlyArray<readonly [string, "success" | PaymentFailureCode]> = [
    [MOCK_CARDS.success, "success"],
    [MOCK_CARDS.declined, "DECLINED"],
    [MOCK_CARDS.insufficientFunds, "INSUFFICIENT_FUNDS"],
    [MOCK_CARDS.processingError, "PROCESSING_ERROR"],
    [OTHER_VALID, "success"],
    [NON_LUHN, "DECLINED"],
  ];

  test("magic card numbers match the documented literals", () => {
    expect(MOCK_CARDS).toEqual({
      success: "4242424242424242",
      declined: "4000000000000002",
      insufficientFunds: "4000000000009995",
      processingError: "4000000000000119",
    });
  });

  for (const [number, expected] of cases) {
    test(`${number.slice(-4)} -> ${expected}, 100 times`, async () => {
      const p = provider();
      for (let i = 0; i < 100; i++) {
        const result = await p.charge(request(number));
        expect(outcomeOf(result)).toBe(expected);
      }
      expect(p.listCharges()).toHaveLength(100);
      expect(p.listCharges().every((c) => c.outcome === expected)).toBe(true);
    });
  }

  test("formatted card numbers (spaces) resolve the same outcome", async () => {
    const p = provider();
    const result = await p.charge(request("4000 0000 0000 0002", { card: rawCard("4000 0000 0000 0002") }));
    expect(outcomeOf(result)).toBe("DECLINED");
  });

  test("success returns providerRef 'mock_' + id and last4", async () => {
    const p = provider();
    const result = await p.charge(request(MOCK_CARDS.success));
    expect(result).toEqual({ ok: true, value: { providerRef: "mock_id1", last4: "4242" } });
    expect(p.listCharges()[0]).toEqual({
      idempotencyKey: `key-${keyCounter}`,
      amountCents: 1999,
      currency: "USD",
      last4: "4242",
      outcome: "success",
      providerRef: "mock_id1",
      createdAt: NOW.toISOString(),
    });
  });

  test("default idGenerator yields unique refs", async () => {
    const p = createMockPaymentProvider();
    const a = await p.charge(request(MOCK_CARDS.success));
    const b = await p.charge(request(MOCK_CARDS.success));
    if (!a.ok || !b.ok) throw new Error("expected success");
    expect(a.value.providerRef).toStartWith("mock_");
    expect(a.value.providerRef).not.toBe(b.value.providerRef);
  });

  test("failures carry stable code and user-safe message", async () => {
    const p = provider();
    for (const [number, code] of [
      [MOCK_CARDS.declined, "DECLINED"],
      [MOCK_CARDS.insufficientFunds, "INSUFFICIENT_FUNDS"],
      [MOCK_CARDS.processingError, "PROCESSING_ERROR"],
    ] as const) {
      const result = await p.charge(request(number));
      expect(result).toEqual({ ok: false, error: { code, message: PAYMENT_FAILURE_MESSAGES[code] } });
    }
    expect(PAYMENT_FAILURE_MESSAGES.DECLINED).toBe("Your card was declined.");
    const failed = p.listCharges();
    expect(failed.every((c) => c.providerRef === undefined && !("providerRef" in c))).toBe(true);
  });
});

describe("amount validation", () => {
  const bad = [0, -1, -1999, 19.99, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
  for (const amountCents of bad) {
    test(`amountCents ${amountCents} -> INVALID_AMOUNT, nothing recorded`, async () => {
      const p = provider();
      const result = await p.charge(request(MOCK_CARDS.success, { amountCents }));
      expect(result).toEqual({
        ok: false,
        error: { code: "INVALID_AMOUNT", message: PAYMENT_FAILURE_MESSAGES.INVALID_AMOUNT },
      });
      expect(p.listCharges()).toHaveLength(0);
    });
  }

  test("INVALID_AMOUNT is not cached: a corrected retry with the same key charges", async () => {
    const p = provider();
    const bad = await p.charge(request(MOCK_CARDS.success, { idempotencyKey: "k", amountCents: 0 }));
    expect(outcomeOf(bad)).toBe("INVALID_AMOUNT");
    const good = await p.charge(request(MOCK_CARDS.success, { idempotencyKey: "k" }));
    expect(outcomeOf(good)).toBe("success");
    expect(p.listCharges()).toHaveLength(1);
  });

  test("Number.MAX_SAFE_INTEGER is accepted", async () => {
    const p = provider();
    const result = await p.charge(request(MOCK_CARDS.success, { amountCents: Number.MAX_SAFE_INTEGER }));
    expect(result.ok).toBe(true);
  });
});

describe("idempotency", () => {
  test("same key twice returns the identical result and records one charge", async () => {
    const p = provider();
    const req = request(MOCK_CARDS.success, { idempotencyKey: "order-1" });
    const first = await p.charge(req);
    const second = await p.charge(req);
    expect(second).toBe(first);
    expect(second).toEqual(first);
    expect(p.listCharges()).toHaveLength(1);
  });

  test("repeat with a different card and amount replays the first result", async () => {
    const p = provider();
    const first = await p.charge(request(MOCK_CARDS.success, { idempotencyKey: "order-2" }));
    const second = await p.charge(
      request(MOCK_CARDS.declined, { idempotencyKey: "order-2", amountCents: 5 }),
    );
    expect(second).toBe(first);
    expect(outcomeOf(second)).toBe("success");
    expect(p.listCharges()).toHaveLength(1);
    expect(p.listCharges()[0]?.amountCents).toBe(1999);
  });

  test("failures are cached under their key too", async () => {
    const p = provider();
    const first = await p.charge(request(MOCK_CARDS.declined, { idempotencyKey: "order-3" }));
    const second = await p.charge(request(MOCK_CARDS.success, { idempotencyKey: "order-3" }));
    expect(second).toBe(first);
    expect(outcomeOf(second)).toBe("DECLINED");
    expect(p.listCharges()).toHaveLength(1);
  });

  for (const latencyMs of [0, 10]) {
    test(`10 concurrent calls with the same key record exactly one charge (latency ${latencyMs}ms)`, async () => {
      const p = new MockPaymentProvider({ latencyMs });
      const req = request(MOCK_CARDS.success, { idempotencyKey: "concurrent" });
      const results = await Promise.all(Array.from({ length: 10 }, () => p.charge(req)));
      expect(p.listCharges()).toHaveLength(1);
      for (const r of results) expect(r).toBe(results[0] as PaymentResult);
    });
  }

  test("results are frozen so a caller cannot corrupt the cached copy", async () => {
    const p = provider();
    const result = await p.charge(request(MOCK_CARDS.success, { idempotencyKey: "frozen" }));
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });

  test("distinct keys each charge", async () => {
    const p = provider();
    await Promise.all([p.charge(request(MOCK_CARDS.success)), p.charge(request(MOCK_CARDS.success))]);
    expect(p.listCharges()).toHaveLength(2);
  });
});

describe("inspection", () => {
  test("listCharges returns a frozen snapshot", async () => {
    const p = provider();
    await p.charge(request(MOCK_CARDS.success));
    const snapshot = p.listCharges();
    expect(Object.isFrozen(snapshot)).toBe(true);
    await p.charge(request(MOCK_CARDS.success));
    expect(snapshot).toHaveLength(1);
    expect(p.listCharges()).toHaveLength(2);
  });

  test("reset clears charges and idempotency results", async () => {
    const p = provider();
    await p.charge(request(MOCK_CARDS.success, { idempotencyKey: "r" }));
    p.reset();
    expect(p.listCharges()).toHaveLength(0);
    await p.charge(request(MOCK_CARDS.declined, { idempotencyKey: "r" }));
    expect(p.listCharges().map((c) => c.outcome)).toEqual(["DECLINED"]);
  });

  test("a charge in flight during reset is not recorded afterwards", async () => {
    const p = new MockPaymentProvider({ latencyMs: 5 });
    const pending = p.charge(request(MOCK_CARDS.success));
    p.reset();
    await pending;
    expect(p.listCharges()).toHaveLength(0);
  });

  test("rejects invalid latencyMs", () => {
    expect(() => new MockPaymentProvider({ latencyMs: -1 })).toThrow(RangeError);
    expect(() => new MockPaymentProvider({ latencyMs: Number.NaN })).toThrow(RangeError);
  });

  test("is usable through the PaymentProvider interface", async () => {
    const injected: PaymentProvider = createMockPaymentProvider();
    const result = await injected.charge(request(MOCK_CARDS.success));
    expect(result.ok).toBe(true);
  });
});

describe("no card data leaks", () => {
  const SIX_PLUS_DIGITS = /\d{6,}/;
  const numbers = [
    MOCK_CARDS.success,
    MOCK_CARDS.declined,
    MOCK_CARDS.insufficientFunds,
    MOCK_CARDS.processingError,
    OTHER_VALID,
    NON_LUHN,
  ];

  test("results, listCharges() and log output contain no 6+ digit run, CVC or expiry", async () => {
    const logs: PaymentLogEvent[] = [];
    // Refs and keys are digit-free so the regex check is meaningful.
    const p = new MockPaymentProvider({ idGenerator: () => "abc", logger: (e) => logs.push(e) });
    const serialized: string[] = [];
    let i = 0;
    for (const number of numbers) {
      const key = `leak-${String.fromCharCode(97 + i++)}`;
      serialized.push(JSON.stringify(await p.charge(request(number, { idempotencyKey: key }))));
      serialized.push(JSON.stringify(await p.charge(request(number, { idempotencyKey: key })))); // replay
      serialized.push(
        JSON.stringify(await p.charge(request(number, { idempotencyKey: "leak-bad", amountCents: 0 }))),
      );
    }
    serialized.push(JSON.stringify(p.listCharges()));
    serialized.push(JSON.stringify(logs));
    expect(logs.length).toBeGreaterThan(0);

    for (const text of serialized) {
      expect(text).not.toMatch(SIX_PLUS_DIGITS);
      expect(text).not.toContain(CVC);
      expect(text).not.toContain("2030");
      expect(text).not.toContain("expMonth");
      expect(text).not.toContain("cvc");
      expect(text).not.toContain("Ada");
    }
    // Only the last four digits appear.
    expect(JSON.stringify(p.listCharges())).toContain(`"last4":"4242"`);
  });

  test("no console output from the provider", async () => {
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const calls: unknown[] = [];
    const capture = (...args: unknown[]) => {
      calls.push(args);
    };
    console.log = capture;
    console.info = capture;
    console.warn = capture;
    console.error = capture;
    console.debug = capture;
    try {
      const p = provider();
      for (const number of numbers) await p.charge(request(number));
      await p.charge(request(MOCK_CARDS.success, { amountCents: -1 }));
    } finally {
      Object.assign(console, original);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("idempotencyKey validation", () => {
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ["empty string", ""],
    ["129 characters", "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)],
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
  ];
  for (const [label, key] of invalid) {
    test(`${label} rejects with TypeError and records nothing`, async () => {
      const p = provider();
      // Simulates an untyped caller.
      const bad = { ...request(MOCK_CARDS.success), idempotencyKey: key } as unknown as ChargeRequest;
      let promise: Promise<PaymentResult> | undefined;
      expect(() => {
        promise = p.charge(bad);
      }).not.toThrow();
      await expect(promise).rejects.toBeInstanceOf(TypeError);
      expect(p.listCharges()).toHaveLength(0);
    });
  }

  test("exactly 128 characters is accepted", async () => {
    const p = provider();
    const result = await p.charge(
      request(MOCK_CARDS.success, { idempotencyKey: "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH) }),
    );
    expect(result.ok).toBe(true);
  });

  test("TypeError message contains no card data", async () => {
    const p = provider();
    const error = await p.charge(request(MOCK_CARDS.success, { idempotencyKey: "" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(String((error as TypeError).message)).not.toMatch(/\d{6,}/);
  });
});

describe("rejected charges are not cached", () => {
  test("idGenerator throws once, then a retry with the same key succeeds and records one charge", async () => {
    let calls = 0;
    const p = new MockPaymentProvider({
      idGenerator: () => {
        calls += 1;
        if (calls === 1) throw new Error("id service down");
        return "recovered";
      },
    });
    const req = request(MOCK_CARDS.success, { idempotencyKey: "flaky" });
    await expect(p.charge(req)).rejects.toThrow("id service down");
    expect(p.listCharges()).toHaveLength(0);

    const retry = await p.charge(req);
    expect(retry).toEqual({ ok: true, value: { providerRef: "mock_recovered", last4: "4242" } });
    expect(p.listCharges()).toHaveLength(1);
    // The settled success is cached as before.
    expect(await p.charge(req)).toBe(retry);
    expect(p.listCharges()).toHaveLength(1);
  });

  test("now() throwing releases the key without recording", async () => {
    let fail = true;
    const p = new MockPaymentProvider({
      now: () => {
        if (fail) throw new Error("clock broken");
        return NOW;
      },
    });
    const req = request(MOCK_CARDS.declined, { idempotencyKey: "clock" });
    await expect(p.charge(req)).rejects.toThrow("clock broken");
    expect(p.listCharges()).toHaveLength(0);
    fail = false;
    expect(outcomeOf(await p.charge(req))).toBe("DECLINED");
    expect(p.listCharges()).toHaveLength(1);
  });

  test("concurrent callers sharing a rejected charge all reject; the next call retries", async () => {
    let calls = 0;
    const p = new MockPaymentProvider({
      latencyMs: 5,
      idGenerator: () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return "ok";
      },
    });
    const req = request(MOCK_CARDS.success, { idempotencyKey: "shared" });
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => p.charge(req)));
    expect(settled.every((s) => s.status === "rejected")).toBe(true);
    expect(calls).toBe(1);
    expect((await p.charge(req)).ok).toBe(true);
    expect(p.listCharges()).toHaveLength(1);
  });

  test("a throwing logger never affects the charge or the cache", async () => {
    const p = new MockPaymentProvider({
      logger: () => {
        throw new Error("logger down");
      },
    });
    const req = request(MOCK_CARDS.success, { idempotencyKey: "log" });
    const first = await p.charge(req);
    expect(first.ok).toBe(true);
    expect(await p.charge(req)).toBe(first);
    expect(outcomeOf(await p.charge(request(MOCK_CARDS.success, { amountCents: 0 })))).toBe("INVALID_AMOUNT");
    expect(p.listCharges()).toHaveLength(1);
  });

  test("settled failures stay cached", async () => {
    const p = provider();
    const req = request(MOCK_CARDS.processingError, { idempotencyKey: "pe" });
    const first = await p.charge(req);
    expect(await p.charge(req)).toBe(first);
    expect(p.listCharges()).toHaveLength(1);
  });
});
