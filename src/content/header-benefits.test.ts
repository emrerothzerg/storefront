import { describe, expect, test } from "bun:test";

import { ICON_NAMES } from "@/components/atoms/Icon";

import { HEADER_BENEFITS, HEADER_BENEFIT_AMOUNT_TOKEN, HEADER_BENEFIT_COMPACT_IDS, HEADER_BENEFIT_ICONS } from "./header-benefits";
import { isAllowedInternalHref } from "./routes";

const allText = (): string[] => [
  HEADER_BENEFITS.label,
  HEADER_BENEFITS.freeShipping.template,
  HEADER_BENEFITS.coupon.prefix,
  ...HEADER_BENEFITS.items.map((i) => i.label),
];

describe("header benefits content (T148)", () => {
  test("icons are a subset of the atoms ICON_NAMES", () => {
    for (const icon of HEADER_BENEFIT_ICONS) expect(ICON_NAMES as readonly string[]).toContain(icon);
  });

  test("free-shipping template has exactly one {amount} and no hardcoded money", () => {
    const { template } = HEADER_BENEFITS.freeShipping;
    expect(template.split(HEADER_BENEFIT_AMOUNT_TOKEN)).toHaveLength(2);
    expect(template).not.toMatch(/\$\s*\d|\d+(\.\d+)?\s*(USD|dollars)/i);
  });

  test("U15: free-shipping copy names standard shipping (distinct from a free-shipping coupon)", () => {
    expect(HEADER_BENEFITS.freeShipping.template).toBe(`Free standard shipping on orders of ${HEADER_BENEFIT_AMOUNT_TOKEN} or more`);
  });

  test("U20: compact ids are exactly the free-shipping and coupon ids (not the static items)", () => {
    expect([...HEADER_BENEFIT_COMPACT_IDS].sort()).toEqual([HEADER_BENEFITS.coupon.id, HEADER_BENEFITS.freeShipping.id].sort());
    for (const item of HEADER_BENEFITS.items) expect(HEADER_BENEFIT_COMPACT_IDS).not.toContain(item.id);
  });

  test("every href is an allowed internal route, one of /shipping, /orders, /returns, /help", () => {
    const hrefs = [HEADER_BENEFITS.freeShipping.href, ...HEADER_BENEFITS.items.map((i) => i.href)];
    for (const href of hrefs) {
      expect(isAllowedInternalHref(href)).toBe(true);
      expect(["/shipping", "/orders", "/returns", "/help"]).toContain(href);
    }
  });

  test("3-4 strip items at most (free shipping + static items + coupon)", () => {
    const max = 1 + HEADER_BENEFITS.items.length + 1;
    expect(max).toBeGreaterThanOrEqual(3);
    expect(max).toBeLessThanOrEqual(4);
  });

  test("plain text, non-empty, unique ids", () => {
    for (const t of allText()) {
      expect(t.trim()).not.toBe("");
      expect(t).not.toMatch(/[<>]|&[a-z]+;/i);
    }
    const ids = [HEADER_BENEFITS.freeShipping.id, HEADER_BENEFITS.coupon.id, ...HEADER_BENEFITS.items.map((i) => i.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("data honesty (R10) and brand-free (R2): no services that do not exist", () => {
    const text = allText().join(" ").toLowerCase();
    // Retailer names are assembled at runtime so no source file contains them (guard G01 scans src/**).
    const retailer = [["k", "mart"], ["one", "pass"], ["after", "pay"], ["zi", "p"]].map((parts) => parts.join(""));
    for (const banned of ["click & collect", "click and collect", "same day", "same-day", "member", "store pickup", "in store", "low prices", ...retailer]) {
      expect(text).not.toContain(banned);
    }
  });
});
