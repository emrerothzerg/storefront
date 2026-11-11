import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AppError, Result } from "@/lib/result";
import type { FieldError } from "@/lib/validation";
import { PHONE_ALLOWED, parseAddressInput, validatePhone } from "@/server/addresses/address-service";
import { createCartService, type CartServiceV2 } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { MOCK_CARDS, createMockPaymentProvider } from "@/server/payments/mock-payment-provider";
import { createOrderService, parseOrderPhone, type OrderServiceV2, type PlaceOrderInputV2 } from "./order-service";

/** T71 request: optional `phone` on PlaceOrderInputV2 (address-book rule), `card: unknown`. */

const NOW = Date.parse("2026-11-04T10:00:00.000Z");
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOTE = "prod_canvas-tote-bag";
const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical Way",
  city: "London",
  region: "LDN",
  postalCode: "N1 9GU",
  country: "GB",
};
const CARD = { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" };

interface Harness {
  readonly db: Database;
  readonly svc: OrderServiceV2;
  readonly carts: CartServiceV2;
}

function setup(): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  const pay = createMockPaymentProvider({ latencyMs: 0, now: () => new Date(NOW) });
  return { db, svc: createOrderService(db, { now: () => NOW, payments: pay, inFlight: new Map() }), carts: createCartService(db, { now: () => NOW }) };
}

function input(extra: Partial<PlaceOrderInputV2> = {}): PlaceOrderInputV2 {
  return { sessionId: S1, address: ADDRESS, card: CARD, idempotencyKey: crypto.randomUUID(), ...extra };
}

function okv<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error("expected ok, got " + JSON.stringify(r.error));
  return r.value;
}

function storedPhone(db: Database, id: string): string | null | undefined {
  return db.query<{ phone: string | null }, [string]>("SELECT phone FROM orders WHERE id = ?").get(id)?.phone;
}

function stock(db: Database): number {
  return db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(TOTE)?.stock ?? -1;
}

const CASES: readonly (readonly [unknown, string | null | "ERR"])[] = [
  [undefined, null],
  [null, null],
  ["", null],
  ["   ", null],
  ["+44 20 7946 0958", "+44 20 7946 0958"],
  ["  (555) 123-4567 ", "(555) 123-4567"],
  ["1234567", "1234567"],
  ["123456", "ERR"],
  ["555-CALL-NOW", "ERR"],
  ["12345678<script>", "ERR"],
  ["1".repeat(21), "ERR"],
  ["1".repeat(500), "ERR"],
  [5551234567, "ERR"],
  [{ n: "5551234567" }, "ERR"],
];

describe("parseOrderPhone", () => {
  test("codes per cause", () => {
    expect(parseOrderPhone("123456")).toMatchObject({ ok: false, error: { code: "INVALID_LENGTH" } });
    expect(parseOrderPhone("555-CALL-NOW")).toMatchObject({ ok: false, error: { code: "INVALID_CHARACTERS" } });
    expect(parseOrderPhone("1".repeat(21))).toMatchObject({ ok: false, error: { code: "TOO_LONG" } });
    expect(parseOrderPhone("1".repeat(10_000))).toMatchObject({ ok: false, error: { code: "TOO_LONG" } });
    expect(parseOrderPhone(42)).toMatchObject({ ok: false, error: { code: "INVALID_TYPE" } });
  });

  test("accepts and rejects exactly what the address book does (parity with parseAddressInput)", () => {
    const base = { fullName: "Ada", line1: "1 Way", city: "London", region: "LDN", postalCode: "N1", country: "GB" };
    for (const [raw, expected] of CASES) {
      const mine = parseOrderPhone(raw);
      expect(mine.ok ? mine.value : "ERR").toBe(expected);
      if (typeof raw === "string" && raw.length > 80) continue; // address book rejects these up front (TOO_LONG)
      const book = parseAddressInput({ ...base, phone: raw });
      expect(book.ok ? (book.value.phone ?? null) : "ERR").toBe(expected);
    }
  });
});

describe("parseOrderPhone parity with the address book (consistency af)", () => {
  // Inputs under the address book's raw-length guard (4x PHONE_MAX), so both
  // parsers reach the same per-field rule.
  const CORPUS: readonly unknown[] = [
    undefined, null, "", "   ", "1234567", "123456", "+44 20 7946 0958", "(555) 123-4567", "555-CALL-NOW",
    "12345678<script>", "1".repeat(20), "1".repeat(21), "1".repeat(80), "+++++++", "1 2 3 4 5 6 7", "１２３４５６７",
    "123\u00004567", "12345\t67", "+1 (555) 0100 ext 9", 42, true, {}, [],
  ];

  test("same accept/reject, same field error code AND message for every input", () => {
    const base = { fullName: "Ada", line1: "1 Way", city: "London", region: "LDN", postalCode: "N1", country: "GB" };
    for (const raw of CORPUS) {
      const mine = parseOrderPhone(raw);
      const book = parseAddressInput({ ...base, phone: raw });
      if (book.ok) {
        expect(mine).toEqual({ ok: true, value: book.value.phone });
      } else {
        const fields = book.error.details?.fields as Record<string, FieldError> | undefined;
        expect(Object.keys(fields ?? {})).toEqual(["phone"]);
        const bookError = fields?.phone;
        if (bookError === undefined) throw new Error("expected a phone field error");
        expect(mine).toEqual({ ok: false, error: bookError });
      }
    }
  });

  test("character and digit rules are the address service's exports (no copy to drift)", () => {
    for (const value of ["1234567", "123456", "555-CALL-NOW", "(555) 123-4567", "+44 20 7946 0958"]) {
      const mine = parseOrderPhone(value);
      const shared = validatePhone(value);
      expect(mine).toEqual(shared === null ? { ok: true, value } : { ok: false, error: shared });
      expect(PHONE_ALLOWED.test(value)).toBe(!(shared?.code === "INVALID_CHARACTERS"));
    }
  });
});

describe("placeOrderV2 phone", () => {
  test("valid phone is cleaned, stored in orders.phone and surfaced on the view (and on reads)", async () => {
    const h = setup();
    okv(h.carts.addItem(S1, TOTE, 1));
    const view = okv(await h.svc.placeOrderV2(input({ phone: "  +1 (555) 123-4567 " }), NOW));
    expect(view.phone).toBe("+1 (555) 123-4567");
    expect(storedPhone(h.db, view.id)).toBe("+1 (555) 123-4567");
    expect(h.svc.getOrderView(view.id, S1, NOW)?.phone).toBe("+1 (555) 123-4567");
  });

  test("absent / null / blank phone -> NULL column, no phone on the view", async () => {
    const h = setup();
    for (const phone of [undefined, null, "  "]) {
      okv(h.carts.addItem(S1, TOTE, 1));
      const view = okv(await h.svc.placeOrderV2(input(phone === undefined ? {} : { phone }), NOW));
      expect(storedPhone(h.db, view.id)).toBeNull();
      expect("phone" in view).toBe(false);
    }
  });

  test("invalid phone -> VALIDATION_FAILED with fields.phone merged with address/card errors; nothing reserved or charged", async () => {
    const h = setup();
    okv(h.carts.addItem(S1, TOTE, 1));
    const before = stock(h.db);
    const bad = await h.svc.placeOrderV2(input({ phone: "123" }), NOW);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("VALIDATION_FAILED");
    expect(bad.error.details?.fields).toEqual({ phone: { code: "INVALID_LENGTH", message: "Phone must contain at least 7 digits." } });

    const both = await h.svc.placeOrderV2(input({ phone: "abc1234567", address: { ...ADDRESS, city: "" }, card: null }), NOW);
    expect(both.ok).toBe(false);
    if (both.ok) return;
    const fields = both.error.details?.fields as Record<string, { code: string }>;
    expect(fields.phone?.code).toBe("INVALID_CHARACTERS");
    expect(fields.city?.code).toBe("REQUIRED");
    expect(Object.keys(fields).some((k) => k !== "phone" && k !== "city")).toBe(true); // card errors present
    expect(stock(h.db)).toBe(before);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orders").get()?.n).toBe(0);
  });

  test("a hostile non-string phone at runtime is rejected, not stored", async () => {
    const h = setup();
    okv(h.carts.addItem(S1, TOTE, 1));
    const hostile = { phone: { toString: () => "5551234567" } } as unknown as Partial<PlaceOrderInputV2>;
    const r = await h.svc.placeOrderV2(input(hostile), NOW);
    expect(r.ok ? "OK" : r.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("placeOrderV2 card: unknown", () => {
  test("non-object card values are validation failures, never throws", async () => {
    const h = setup();
    okv(h.carts.addItem(S1, TOTE, 1));
    for (const card of [null, undefined, "4242", 42, [], { number: 1 }]) {
      const r = await h.svc.placeOrderV2(input({ card }), NOW);
      expect(r.ok ? "OK" : r.error.code).toBe("VALIDATION_FAILED");
    }
  });
});
