import { describe, expect, test } from "bun:test";
import { tooManyAttemptsMessage } from "@/app/actions/account-core";
import { ACCOUNT_FIELD } from "../_contracts/account-actions";
import { ACCOUNT_FIELD_IDS, ACCOUNT_FIELD_LABELS, fieldErrorOf, summaryItems, tooManyAttemptsText } from "./index";
import { failure } from "./_test-utils";
import type { AccountFailure } from "./index";

function asFailure(state: ReturnType<typeof failure>): AccountFailure {
  if (state === null || state.ok) throw new Error("expected failure");
  return state;
}

describe("shared helpers", () => {
  test("tooManyAttemptsText matches the action's wording", () => {
    for (const s of [1, 59, 60, 61, 900, 3600]) expect(tooManyAttemptsText(s)).toBe(tooManyAttemptsMessage(s));
    expect(tooManyAttemptsText(61)).toBe("Too many attempts. Try again in 2 minutes.");
    expect(tooManyAttemptsText(60)).toBe("Too many attempts. Try again in 1 minute.");
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(tooManyAttemptsText(bad)).toBe("Too many attempts. Try again later.");
    }
  });

  test("ids/labels cover every contract field", () => {
    expect(Object.keys(ACCOUNT_FIELD_IDS).sort()).toEqual(Object.keys(ACCOUNT_FIELD).sort());
    expect(ACCOUNT_FIELD_LABELS.confirm).toBe("Type DELETE to confirm");
  });

  test("summaryItems keeps the given order, only listed fields, skips blanks", () => {
    const f = asFailure(
      failure("VALIDATION_FAILED", "m", { confirmPassword: "No match", currentPassword: "Wrong", newPassword: "  ", displayName: "x" }),
    );
    expect(summaryItems(f, ["currentPassword", "newPassword", "confirmPassword"]).map((i) => i.field)).toEqual([
      "currentPassword",
      "confirmPassword",
    ]);
    expect(fieldErrorOf(f, "newPassword")).toBeUndefined();
    expect(fieldErrorOf(null, "newPassword")).toBeUndefined();
    expect(fieldErrorOf(f, "currentPassword")).toBe("Wrong");
  });
});
