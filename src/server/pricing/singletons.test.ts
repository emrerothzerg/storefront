import { afterEach, expect, test } from "bun:test";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { getCouponService } from "./coupon-service";
import { getShippingService } from "./shipping-service";

const previous = process.env.DATABASE_PATH;

afterEach(() => {
  closeDatabase();
  if (previous === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previous;
});

test("getCouponService / getShippingService are cached per shared database and rebuilt when it changes", () => {
  process.env.DATABASE_PATH = ":memory:";
  const coupons = getCouponService();
  const shipping = getShippingService();
  expect(getCouponService()).toBe(coupons);
  expect(getShippingService()).toBe(shipping);
  // Migrated but unseeded shared DB: empty but working.
  expect(shipping.listMethods(0)).toEqual([]);
  expect(coupons.listPromoted()).toEqual([]);

  closeDatabase();
  getDatabase();
  expect(getCouponService()).not.toBe(coupons);
  expect(getShippingService()).not.toBe(shipping);
});
