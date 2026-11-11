/**
 * QA suite for src/lib/types.ts (T06, criteria 5 and 6).
 * Compile-time assertions run under `bun run typecheck` (tsconfig includes tests/).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ERROR_CODES } from "@/lib/types";
import type {
  Address,
  CardInput,
  Cart,
  CartItem,
  ErrorCode,
  Order,
  OrderItem,
  OrderStatus,
  PaymentFailure,
  PaymentSuccess,
  Product,
} from "@/lib/types";
import type { AppError, Result } from "@/lib/result";
import type { ValidatedCard } from "@/lib/validation";

// --- type-level helpers ----------------------------------------------------
type IsAny<T> = 0 extends 1 & T ? true : false;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** true if any property (one level deep, plus array elements) is `any`. */
type HasAnyField<T> = true extends { [K in keyof T]-?: IsAny<T[K]> }[keyof T] ? true : false;
function assertType<T extends true>(): T | undefined {
  return undefined;
}

// No `any` in any exported domain type.
assertType<Equals<HasAnyField<Product>, false>>();
assertType<Equals<HasAnyField<CartItem>, false>>();
assertType<Equals<HasAnyField<Cart>, false>>();
assertType<Equals<HasAnyField<Cart["items"][number]>, false>>();
assertType<Equals<HasAnyField<Address>, false>>();
assertType<Equals<HasAnyField<CardInput>, false>>();
assertType<Equals<HasAnyField<PaymentSuccess>, false>>();
assertType<Equals<HasAnyField<PaymentFailure>, false>>();
assertType<Equals<HasAnyField<Order>, false>>();
assertType<Equals<HasAnyField<OrderItem>, false>>();
assertType<Equals<HasAnyField<AppError>, false>>();
assertType<Equals<HasAnyField<ValidatedCard>, false>>();
assertType<Equals<IsAny<ErrorCode>, false>>();
assertType<Equals<IsAny<Result<number>>, false>>();
assertType<Equals<IsAny<NonNullable<AppError["details"]>[string]>, false>>(); // unknown, not any

// Order status is exactly "paid" | "payment_failed".
assertType<Equals<OrderStatus, "paid" | "payment_failed">>();
assertType<Equals<Order["status"], "paid" | "payment_failed">>();

// --- runtime checks ---------------------------------------------------------
const ROOT = join(import.meta.dir, "..", "..");
const LIB = join(ROOT, "src", "lib");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("types", () => {
  test("Order status rejects other strings at compile time", () => {
    const paid: OrderStatus = "paid";
    const failed: OrderStatus = "payment_failed";
    // @ts-expect-error "refunded" is not an OrderStatus
    const bad: OrderStatus = "refunded";
    expect([paid, failed, bad]).toHaveLength(3);
  });

  test("ERROR_CODES is a unique list containing the codes T06 relies on", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const c of ["INVALID_QUANTITY", "INVALID_INPUT", "VALIDATION_FAILED", "MONEY_OVERFLOW"]) {
      expect(ERROR_CODES as readonly string[]).toContain(c);
    }
  });

  test("non-test src/lib sources contain no any / ts-ignore / eslint-disable / enum", () => {
    const offenders: string[] = [];
    for (const file of walk(LIB).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/:\s*any\b|\bas any\b|<any>|@ts-ignore|@ts-nocheck|eslint-disable|\benum\s+\w/.test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  test("formatPrice is removed or defined in at most one place", () => {
    const definers = walk(join(ROOT, "src")).filter((f) => {
      if (!/\.tsx?$/.test(f)) return false;
      return /export\s+(function|const|\{[^}]*)\s*formatPrice\b/.test(readFileSync(f, "utf8"));
    });
    expect(definers.length).toBeLessThanOrEqual(1);
  });
});
