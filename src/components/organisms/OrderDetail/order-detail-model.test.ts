import { describe, expect, test } from "bun:test";
import {
  cancelMinutesLeft,
  cancelWindowText,
  invoiceHref,
  orderHelpHref,
  paymentLabel,
  refundNoticeText,
  shipToLines,
} from "./order-detail-model";
import { ORDER_ID, PLACED_AT, PLACED_MS } from "./order-view.fixtures";

const MIN = 60_000;

describe("cancelMinutesLeft", () => {
  test("30 min window from placement, floored", () => {
    expect(cancelMinutesLeft(PLACED_AT, PLACED_MS)).toBe(30);
    expect(cancelMinutesLeft(PLACED_AT, PLACED_MS + 10 * MIN + 30_000)).toBe(19);
    expect(cancelMinutesLeft(PLACED_AT, PLACED_MS + 29 * MIN)).toBe(1);
    expect(cancelMinutesLeft(PLACED_AT, PLACED_MS + 29 * MIN + 1)).toBe(0);
    expect(cancelMinutesLeft(PLACED_AT, PLACED_MS + 31 * MIN)).toBe(0);
  });
  test("an earlier cancellableUntil wins; clock skew before placement caps at 30", () => {
    expect(cancelMinutesLeft(PLACED_AT, PLACED_MS, "2026-11-07T10:05:00.000Z")).toBe(5);
    expect(cancelMinutesLeft(PLACED_AT, PLACED_MS, "2026-11-07T11:00:00.000Z")).toBe(30);
    expect(cancelMinutesLeft(PLACED_AT, PLACED_MS - 60 * MIN)).toBe(30);
  });
  test("invalid input -> 0", () => {
    expect(cancelMinutesLeft("not a date", PLACED_MS)).toBe(0);
    expect(cancelMinutesLeft(undefined, PLACED_MS)).toBe(0);
    expect(cancelMinutesLeft(PLACED_AT, Number.NaN)).toBe(0);
  });
  test("text pluralises", () => {
    expect(cancelWindowText(1)).toBe("You can cancel for 1 more minute.");
    expect(cancelWindowText(12)).toBe("You can cancel for 12 more minutes.");
  });
});

describe("paymentLabel (criterion 4)", () => {
  test("brand + last4 only", () => {
    expect(paymentLabel("4242", "Visa")).toBe("Visa ending in 4242");
    expect(paymentLabel("4242")).toBe("Card ending in 4242");
    expect(paymentLabel("4242", "<b>Evil</b>")).toBe("Card ending in 4242");
  });
  test("anything but four digits -> null", () => {
    for (const bad of ["4242424242424242", "42a2", "", "424", null, 4242]) expect(paymentLabel(bad)).toBeNull();
  });
});

describe("shipToLines", () => {
  test("formats lines and skips blanks; email never included", () => {
    expect(
      shipToLines({ fullName: "Jane", line1: "1 Main", line2: " ", city: "Springfield", region: "IL", postalCode: "62701", country: "US" }),
    ).toEqual(["Jane", "1 Main", "Springfield, IL 62701", "US"]);
    expect(shipToLines(null)).toEqual([]);
  });
});

describe("hrefs", () => {
  test("invoice and help hrefs are allowed internal hrefs", () => {
    expect(invoiceHref(ORDER_ID)).toBe(`/orders/${ORDER_ID}/invoice`);
    expect(orderHelpHref(ORDER_ID)).toBe(`/contact?topic=ordering&order=${ORDER_ID}`);
  });
  test("ids that break the route are dropped", () => {
    expect(invoiceHref("..")).toBeNull();
    expect(invoiceHref("")).toBeNull();
  });
});

describe("refundNoticeText (criterion 5)", () => {
  test("states the refund is pending and simulated", () => {
    expect(refundNoticeText(4198, "USD", "4242")).toBe(
      "A refund of $41.98 to the card ending in 4242 is pending. Payments in this store are simulated, so no money is moved.",
    );
  });
  test("zero total and bad data", () => {
    expect(refundNoticeText(0, "USD", "4242")).toContain("nothing to refund");
    expect(refundNoticeText(-5, "USD", "x")).toBe(
      "A refund is pending. Payments in this store are simulated, so no money is moved.",
    );
    expect(refundNoticeText(100, "NOT-A-CURRENCY", "4242")).toContain("A refund to the card ending in 4242");
  });
});
