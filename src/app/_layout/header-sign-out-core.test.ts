import { describe, expect, mock, test } from "bun:test";

import type { AuthActionState } from "@/components/molecules/_contracts/auth-actions";

import { runHeaderSignOut } from "./header-sign-out-core";

class RedirectSentinel extends Error {}

describe("runHeaderSignOut", () => {
  test("calls auth signOut with the initial (null) state and the posted form data", async () => {
    const signOut = mock(async (state: AuthActionState, formData: FormData): Promise<AuthActionState> => {
      void state;
      void formData;
      return null;
    });
    const formData = new FormData();
    await runHeaderSignOut(formData, async () => ({ signOut }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut.mock.calls[0]?.[0]).toBeNull();
    expect(signOut.mock.calls[0]?.[1]).toBe(formData);
  });

  test("the redirect thrown by signOut propagates unchanged", async () => {
    const sentinel = new RedirectSentinel("/");
    const signOut = async (): Promise<AuthActionState> => {
      throw sentinel;
    };
    await expect(runHeaderSignOut(new FormData(), async () => ({ signOut }))).rejects.toBe(sentinel);
  });

  test("a failing module load propagates (the action fails instead of pretending to sign out)", async () => {
    const failure = new Error("load failed");
    await expect(
      runHeaderSignOut(new FormData(), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  test("the default loader resolves auth.ts's signOut", async () => {
    const { loadAuthSignOut } = await import("./header-sign-out-core");
    const auth = await import("@/app/actions/auth");
    expect((await loadAuthSignOut()).signOut).toBe(auth.signOut);
  });
});
