/**
 * QA suite for src/lib/result.ts (T06): plain-JSON results and wire guards.
 */
import { describe, expect, test } from "bun:test";
import { andThen, appError, err, fail, isAppError, isErrorCode, isErr, isOk, mapResult, ok } from "@/lib/result";
import { ERROR_CODES } from "@/lib/types";

describe("result", () => {
  test("constructors produce plain objects that survive JSON", () => {
    for (const r of [ok(1), ok({ a: [1, 2] }), err("x"), fail("INVALID_INPUT", "m"), fail("MONEY_OVERFLOW", "m", { max: 1 })]) {
      expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    }
  });

  test("appError omits details key entirely when not given", () => {
    expect("details" in appError("INVALID_INPUT", "m")).toBe(false);
    expect(Object.keys(fail("INVALID_INPUT", "m").error)).toEqual(["code", "message"]);
  });

  test("guards and combinators", () => {
    const a = ok(2);
    const b = fail("INVALID_INPUT", "no");
    expect(isOk(a) && !isErr(a)).toBe(true);
    expect(isErr(b) && !isOk(b)).toBe(true);
    expect(mapResult(a, (n) => n * 2)).toEqual(ok(4));
    expect(mapResult(b, () => 1)).toBe(b);
    expect(andThen(a, () => b)).toBe(b);
    let called = false;
    andThen(b, () => {
      called = true;
      return ok(1);
    });
    expect(called).toBe(false);
  });

  test("isErrorCode accepts every listed code and rejects hostile values", () => {
    for (const c of ERROR_CODES) expect(isErrorCode(c)).toBe(true);
    for (const v of ["", "invalid_input", "toString", "__proto__", "constructor", null, undefined, 1, {}, ["INVALID_INPUT"]]) {
      expect(isErrorCode(v)).toBe(false);
    }
  });

  test("isAppError on wire data", () => {
    expect(isAppError({ code: "INVALID_INPUT", message: "m" })).toBe(true);
    expect(isAppError({ code: "INVALID_INPUT", message: "m", details: {} })).toBe(true);
    expect(isAppError(JSON.parse(JSON.stringify(fail("MONEY_OVERFLOW", "m", { max: 9 }).error)))).toBe(true);
    const nullProto = Object.assign(Object.create(null) as object, { code: "INVALID_INPUT", message: "m" });
    expect(isAppError(nullProto)).toBe(true);
    for (const v of [
      null,
      undefined,
      "INVALID_INPUT",
      [],
      { code: "NOPE", message: "m" },
      { code: "INVALID_INPUT" },
      { code: "INVALID_INPUT", message: 1 },
      { code: "INVALID_INPUT", message: "m", details: null },
      { code: "INVALID_INPUT", message: "m", details: [] },
      { code: "INVALID_INPUT", message: "m", details: "x" },
    ]) {
      expect(isAppError(v)).toBe(false);
    }
  });
});
