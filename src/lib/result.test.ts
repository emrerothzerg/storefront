import { describe, expect, test } from "bun:test";
import {
  andThen,
  appError,
  err,
  fail,
  isAppError,
  isErr,
  isErrorCode,
  isOk,
  mapResult,
  ok,
  type Result,
} from "./result";

const half = (n: number): Result<number> =>
  n % 2 === 0 ? ok(n / 2) : fail("INVALID_INPUT", "odd");

describe("result", () => {
  test("ok and err build discriminated values", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err("x")).toEqual({ ok: false, error: "x" });
  });

  test("appError omits details when absent; fail wraps it in err", () => {
    expect(appError("EMPTY_CART", "Cart is empty")).toEqual({
      code: "EMPTY_CART",
      message: "Cart is empty",
    });
    expect("details" in appError("EMPTY_CART", "m")).toBe(false);
    expect(fail("ORDER_NOT_FOUND", "nope", { id: "o1" })).toEqual({
      ok: false,
      error: { code: "ORDER_NOT_FOUND", message: "nope", details: { id: "o1" } },
    });
  });

  test("type guards narrow", () => {
    const r: Result<number> = half(4);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) expect(r.value).toBe(2);
    const e = half(3);
    expect(isErr(e)).toBe(true);
    if (isErr(e)) expect(e.error.code).toBe("INVALID_INPUT");
  });

  test("mapResult transforms ok and passes errors through", () => {
    expect(mapResult(ok(2), (n) => n * 10)).toEqual(ok(20));
    const e = fail("PAYMENT_FAILED", "declined");
    expect(mapResult(e, () => 1)).toBe(e);
  });

  test("andThen chains and short-circuits on the first error", () => {
    expect(andThen(half(8), half)).toEqual(ok(2));
    const r = andThen(half(6), half);
    expect(r.ok).toBe(false);
    let called = false;
    andThen(half(1), (n) => {
      called = true;
      return ok(n);
    });
    expect(called).toBe(false);
  });

  test("results survive a JSON round trip", () => {
    const values: readonly Result<{ a: number }>[] = [
      ok({ a: 1 }),
      fail("STOCK_CHANGED", "Stock changed", { productId: "p1", available: 0 }),
    ];
    for (const v of values) expect(JSON.parse(JSON.stringify(v))).toEqual(v);
  });

  test("isErrorCode and isAppError validate unknown data", () => {
    expect(isErrorCode("MONEY_OVERFLOW")).toBe(true);
    expect(isErrorCode("NOPE")).toBe(false);
    expect(isErrorCode(1)).toBe(false);
    expect(isAppError({ code: "EMPTY_CART", message: "m" })).toBe(true);
    expect(isAppError({ code: "EMPTY_CART", message: "m", details: { x: 1 } })).toBe(true);
    expect(isAppError({ code: "EMPTY_CART", message: "m", details: [1] })).toBe(false);
    expect(isAppError({ code: "BOGUS", message: "m" })).toBe(false);
    expect(isAppError({ code: "EMPTY_CART" })).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError("EMPTY_CART")).toBe(false);
  });
});
