import { describe, expect, test } from "bun:test";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteCartRepository } from "./cart-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return { db, repo: new SqliteCartRepository(db) };
}

describe("SqliteCartRepository settings (T45)", () => {
  test("getSettings is null without a cart or with an invalid id; defaults are null", () => {
    const { repo } = setup();
    expect(repo.getSettings(S1)).toBeNull();
    expect(repo.getSettings("'; DROP TABLE carts; --")).toBeNull();
    repo.ensureCart(S1, "USD");
    expect(repo.getSettings(S1)).toEqual({ couponCode: null, shippingMethodId: null });
  });

  test("set and clear coupon and shipping per session", () => {
    const { repo } = setup();
    repo.ensureCart(S1, "USD");
    repo.ensureCart(S2, "USD");
    repo.setCouponCode(S1, "WELCOME10");
    repo.setShippingMethodId(S1, "express");
    expect(repo.getSettings(S1)).toEqual({ couponCode: "WELCOME10", shippingMethodId: "express" });
    expect(repo.getSettings(S2)).toEqual({ couponCode: null, shippingMethodId: null });
    repo.setCouponCode(S1, null);
    repo.setShippingMethodId(S1, null);
    expect(repo.getSettings(S1)).toEqual({ couponCode: null, shippingMethodId: null });
  });

  test("ensureCart keeps stored settings", () => {
    const { repo } = setup();
    repo.ensureCart(S1, "USD");
    repo.setCouponCode(S1, "SAVE5");
    repo.ensureCart(S1, "USD");
    expect(repo.getSettings(S1)?.couponCode).toBe("SAVE5");
  });

  test("setters are no-ops without a cart row", () => {
    const { db, repo } = setup();
    repo.setCouponCode(S1, "X");
    repo.setShippingMethodId(S1, "standard");
    expect(db.query("SELECT COUNT(*) AS n FROM carts").get()).toEqual({ n: 0 });
  });

  test("clearCouponIf only clears the matching code", () => {
    const { repo } = setup();
    repo.ensureCart(S1, "USD");
    repo.setCouponCode(S1, "NEWER");
    expect(repo.clearCouponIf(S1, "OLDER")).toBe(false);
    expect(repo.getSettings(S1)?.couponCode).toBe("NEWER");
    expect(repo.clearCouponIf(S1, "NEWER")).toBe(true);
    expect(repo.getSettings(S1)?.couponCode).toBeNull();
    expect(repo.clearCouponIf(S2, "NEWER")).toBe(false);
  });

  test("writes reject invalid session ids", () => {
    const { repo } = setup();
    expect(() => repo.setCouponCode("nope", "X")).toThrow(TypeError);
    expect(() => repo.clearCouponIf("nope", "X")).toThrow(TypeError);
    expect(() => repo.setShippingMethodId("nope", "standard")).toThrow(TypeError);
  });
});
