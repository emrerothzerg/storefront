import { describe, expect, test } from "bun:test";

import { HEADER_BENEFITS, type HeaderBenefitsContent } from "@/content/header-benefits";
import { isAllowedInternalHref } from "@/content/routes";

import { HEADER_BENEFITS_FALLBACK, buildHeaderBenefits, formatThreshold } from "./header-benefits";

const COUPON = { code: "WELCOME10", description: "10% off" };

describe("buildHeaderBenefits", () => {
  test("seeded facts: free shipping ($35), track order, returns, coupon; label from content", () => {
    const strip = buildHeaderBenefits({ freeShippingThresholdCents: 3500, currency: "USD", coupon: COUPON });
    expect(strip.label).toBe("Store benefits");
    expect(strip.items).toEqual([
      { id: "free-shipping", label: "Free standard shipping on orders of $35 or more", icon: "truck", href: "/shipping" },
      { id: "track-order", label: "Track your order", icon: "package", href: "/orders" },
      { id: "returns", label: "Returns and refunds", icon: "refresh", href: "/returns" },
      { id: "promo-code", label: "Use code WELCOME10 for 10% off", icon: "tag" },
    ]);
  });

  test("the threshold text follows the data (never hardcoded)", () => {
    const fifty = buildHeaderBenefits({ freeShippingThresholdCents: 5000, currency: "USD", coupon: null });
    expect(fifty.items[0]?.label).toBe("Free standard shipping on orders of $50 or more");
    const odd = buildHeaderBenefits({ freeShippingThresholdCents: 4999, currency: "USD", coupon: null });
    expect(odd.items[0]?.label).toBe("Free standard shipping on orders of $49.99 or more");
  });

  test("no threshold (null, invalid amount or currency) -> no free-shipping item; the rest stays", () => {
    for (const [cents, currency] of [
      [null, "USD"],
      [0, "USD"],
      [-100, "USD"],
      [12.5, "USD"],
      [3500, "NOT-A-CURRENCY"],
    ] as const) {
      const strip = buildHeaderBenefits({ freeShippingThresholdCents: cents, currency, coupon: null });
      expect(strip.items.map((i) => i.id)).toEqual(["track-order", "returns"]);
    }
  });

  test("coupon: omitted when null or its code is malformed; description is text", () => {
    const none = buildHeaderBenefits({ freeShippingThresholdCents: 3500, currency: "USD", coupon: null });
    expect(none.items.some((i) => i.id === "promo-code")).toBe(false);
    const bad = buildHeaderBenefits({
      freeShippingThresholdCents: 3500,
      currency: "USD",
      coupon: { code: "<b>x</b>", description: "10% off" },
    });
    expect(bad.items.some((i) => i.id === "promo-code")).toBe(false);
    const ship = buildHeaderBenefits({
      freeShippingThresholdCents: null,
      currency: "USD",
      coupon: { code: "SHIPFREE", description: "Free shipping on orders of $20.00 or more" },
    });
    expect(ship.items.at(-1)?.label).toBe("Use code SHIPFREE for free shipping on orders of $20.00 or more");
    expect(ship.items.at(-1)?.href).toBeUndefined();
  });

  test("content absent (null) -> hardcoded fallback copy", () => {
    const strip = buildHeaderBenefits({ freeShippingThresholdCents: 3500, currency: "USD", coupon: COUPON, content: null });
    expect(strip).toEqual(buildHeaderBenefits({ freeShippingThresholdCents: 3500, currency: "USD", coupon: COUPON, content: HEADER_BENEFITS_FALLBACK }));
    expect(strip.items).toHaveLength(4);
  });

  test("malformed content parts fall back individually", () => {
    const broken = {
      label: "  ",
      freeShipping: { id: "fs", template: "Free shipping for everyone", icon: "truck", href: "/shipping" },
      items: [{ id: "x", label: "Evil", icon: "package", href: "https://evil.example" }],
      coupon: { id: "c", prefix: " ", icon: "tag" },
    } as const satisfies HeaderBenefitsContent;
    const strip = buildHeaderBenefits({ freeShippingThresholdCents: 3500, currency: "USD", coupon: COUPON, content: broken });
    expect(strip.label).toBe(HEADER_BENEFITS_FALLBACK.label);
    expect(strip.items.map((i) => i.label)).toEqual([
      "Free standard shipping on orders of $35 or more",
      "Track your order",
      "Returns and refunds",
      "Use code WELCOME10 for 10% off",
    ]);
  });

  test("valid custom content is used as given (template with {amount}, own items)", () => {
    const custom: HeaderBenefitsContent = {
      label: "Why shop here",
      freeShipping: { id: "fs", template: "{amount}+ ships free", icon: "truck", href: "/shipping" },
      items: [{ id: "help", label: "Help centre", icon: "package", href: "/help" }],
      coupon: { id: "c", prefix: "Code", icon: "tag" },
    };
    const strip = buildHeaderBenefits({ freeShippingThresholdCents: 2000, currency: "USD", coupon: COUPON, content: custom });
    expect(strip.label).toBe("Why shop here");
    expect(strip.items.map((i) => i.label)).toEqual(["$20+ ships free", "Help centre", "Code WELCOME10 for 10% off"]);
  });

  test("every link is an allowed internal route from the G-12 set", () => {
    const strip = buildHeaderBenefits({ freeShippingThresholdCents: 3500, currency: "USD", coupon: COUPON });
    for (const item of strip.items) {
      if (item.href === undefined || item.href === null) continue;
      expect(isAllowedInternalHref(item.href)).toBe(true);
      expect(["/shipping", "/orders", "/returns", "/help"]).toContain(item.href);
    }
  });

  test("formatThreshold drops .00 only for whole amounts", () => {
    expect(formatThreshold(3500, "USD")).toBe("$35");
    expect(formatThreshold(3550, "USD")).toBe("$35.50");
    expect(formatThreshold(0, "USD")).toBeNull();
    expect(formatThreshold(Number.POSITIVE_INFINITY, "USD")).toBeNull();
  });

  test("the fallback mirrors the content module (same facts, so a missing module changes nothing)", () => {
    expect(HEADER_BENEFITS_FALLBACK).toEqual(HEADER_BENEFITS);
  });
});
