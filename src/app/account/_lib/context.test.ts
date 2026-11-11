import { describe, expect, test } from "bun:test";

import { loadAccountContext } from "./context";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = { id: "user-1", email: "u@example.test", displayName: "U" };

describe("loadAccountContext", () => {
  test("passes through a valid owner key and user", async () => {
    const ctx = await loadAccountContext({ readOwnerAndUser: async () => ({ ownerKey: OWNER, user: USER }) });
    expect(ctx).toEqual({ ownerKey: OWNER, user: USER });
  });

  test("one lookup per call", async () => {
    let calls = 0;
    await loadAccountContext({
      readOwnerAndUser: async () => {
        calls += 1;
        return { ownerKey: OWNER, user: USER };
      },
    });
    expect(calls).toBe(1);
  });

  test("guest: nulls", async () => {
    expect(await loadAccountContext({ readOwnerAndUser: async () => ({ ownerKey: null, user: null }) })).toEqual({
      ownerKey: null,
      user: null,
    });
  });

  test("a malformed owner key is dropped", async () => {
    const ctx = await loadAccountContext({ readOwnerAndUser: async () => ({ ownerKey: "garbage", user: null }) });
    expect(ctx.ownerKey).toBeNull();
  });

  test("reader failures read as signed out / no cookie, never throw", async () => {
    const ctx = await loadAccountContext({
      readOwnerAndUser: async () => {
        throw new Error("db down");
      },
    });
    expect(ctx).toEqual({ ownerKey: null, user: null });
  });

  test("Next control-flow errors are rethrown", async () => {
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/x;307;" });
    await expect(
      loadAccountContext({
        readOwnerAndUser: async () => {
          throw redirectError;
        },
      }),
    ).rejects.toBe(redirectError);
  });
});
