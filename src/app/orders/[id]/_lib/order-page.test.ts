import { describe, expect, mock, test } from "bun:test";
import type { Address, Order } from "@/lib/types";
import { formatAddress, formatOrderNumber, loadOrderPage, orderStatusLabel, paymentFailureSentence, type OrderReader } from "./order-page";

const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ADDRESS: Address = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical Way",
  city: "London",
  region: "LDN",
  postalCode: "N1 9GU",
  country: "GB",
};

const ORDER: Order = {
  id: ID,
  sessionId: SESSION,
  status: "paid",
  items: [],
  subtotalCents: 0,
  shippingCents: 0,
  totalCents: 0,
  currency: "USD",
  address: ADDRESS,
  cardLast4: "4242",
  idempotencyKey: "k",
  createdAt: "2026-11-06T12:00:00.000Z",
};

function reader(result: Order | null) {
  const getOrder = mock<OrderReader["getOrder"]>(() => result);
  return { getOrder };
}

describe("loadOrderPage", () => {
  test("returns the service's order for a well-formed id", () => {
    const orders = reader(ORDER);
    expect(loadOrderPage(ID, SESSION, orders)).toBe(ORDER);
    expect(orders.getOrder).toHaveBeenCalledWith(ID, SESSION);
  });

  test("returns null when the service does (unknown / other session)", () => {
    expect(loadOrderPage(ID, SESSION, reader(null))).toBeNull();
  });

  test("malformed ids and null sessions never touch the service", () => {
    const orders = reader(ORDER);
    for (const id of ["not-a-uuid", ID.toUpperCase(), "1; DROP TABLE orders", "", 42, null, undefined, { id: ID }]) {
      expect(loadOrderPage(id, SESSION, orders)).toBeNull();
    }
    expect(loadOrderPage(ID, null, orders)).toBeNull();
    expect(orders.getOrder).not.toHaveBeenCalled();
  });
});

describe("display helpers", () => {
  test("formatOrderNumber: first 8 chars upper-cased", () => {
    expect(formatOrderNumber(ID)).toBe("0F1E2D3C");
  });

  test("orderStatusLabel", () => {
    expect(orderStatusLabel("paid")).toEqual({ label: "Paid", tone: "success" });
    expect(orderStatusLabel("payment_failed")).toEqual({ label: "Payment failed", tone: "danger" });
  });

  test("paymentFailureSentence always says the card was not charged", () => {
    for (const code of ["DECLINED", "INSUFFICIENT_FUNDS", "PROCESSING_ERROR", "INVALID_AMOUNT", undefined] as const) {
      expect(paymentFailureSentence(code)).toContain("not charged");
    }
    expect(paymentFailureSentence("DECLINED")).toBe("Your card was declined, so it was not charged.");
  });

  test("formatAddress omits an empty or missing line2", () => {
    const expected = ["Ada Lovelace", "1 Analytical Way", "London, LDN N1 9GU", "GB"];
    expect(formatAddress(ADDRESS)).toEqual(expected);
    expect(formatAddress({ ...ADDRESS, line2: "" })).toEqual(expected);
    expect(formatAddress({ ...ADDRESS, line2: "   " })).toEqual(expected);
    expect(formatAddress({ ...ADDRESS, line2: "Flat 2" })).toEqual([
      "Ada Lovelace",
      "1 Analytical Way",
      "Flat 2",
      "London, LDN N1 9GU",
      "GB",
    ]);
  });
});
