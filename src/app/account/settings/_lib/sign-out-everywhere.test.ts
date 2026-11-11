import { describe, expect, mock, test } from "bun:test";

import { appError } from "@/lib/result";
import type { ErrorCode } from "@/lib/types";
import type { AccountActionFn, AccountActionState } from "@/components/molecules/_contracts/account-actions";

import { runSignOutEverywhere } from "./sign-out-everywhere";

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const redirect = (url: string): never => {
  throw new RedirectSentinel(url);
};
/** Mirrors unstable_rethrow: control-flow (redirect) errors are rethrown. */
const rethrow = (error: unknown): void => {
  if (error instanceof RedirectSentinel) throw error;
};

function failure(code: ErrorCode): AccountActionState {
  return { ok: false, error: appError(code, "x"), message: "x", fieldErrors: {}, values: {} };
}

async function redirectOf(action: AccountActionFn, formData = new FormData()): Promise<string> {
  try {
    await runSignOutEverywhere({ action, redirect, rethrow }, formData);
  } catch (error) {
    if (error instanceof RedirectSentinel) return error.url;
    throw error;
  }
  throw new Error("expected a redirect");
}

describe("runSignOutEverywhere", () => {
  test("success: the action's own redirect to / is rethrown untouched", async () => {
    const action = mock(async (): Promise<AccountActionState> => redirect("/"));
    expect(await redirectOf(action)).toBe("/");
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("calls the action with prevState null and the posted FormData", async () => {
    const fd = new FormData();
    fd.set("anything", "1");
    const calls: [AccountActionState, FormData][] = [];
    const action: AccountActionFn = async (prev, posted) => {
      calls.push([prev, posted]);
      return redirect("/");
    };
    await redirectOf(action, fd);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBeNull();
    expect(calls[0]?.[1]).toBe(fd);
  });

  test("UNAUTHENTICATED -> sign-in page with next=/account/settings", async () => {
    expect(await redirectOf(async () => failure("UNAUTHENTICATED"))).toBe("/signin?next=%2Faccount%2Fsettings");
  });

  test("INTERNAL_ERROR -> settings page with the sessions error flag", async () => {
    expect(await redirectOf(async () => failure("INTERNAL_ERROR"))).toBe("/account/settings?sessions=error");
  });

  test("an unexpected null or ok state is treated as a failure", async () => {
    expect(await redirectOf(async () => null)).toBe("/account/settings?sessions=error");
    expect(await redirectOf(async () => ({ ok: true, kind: "password_changed", message: "x" }))).toBe(
      "/account/settings?sessions=error",
    );
  });

  test("an unexpected throw (network/DB) settles as the error redirect", async () => {
    expect(
      await redirectOf(async () => {
        throw new Error("database is locked");
      }),
    ).toBe("/account/settings?sessions=error");
  });
});
