import { describe, expect, mock, test } from "bun:test";

import { isAllowedInternalHref } from "@/content/routes";
import type { CurrentUser } from "@/server/session/current-user";

import {
  SESSIONS_ERROR_HREF,
  SETTINGS_PATH,
  SETTINGS_SECTION_IDS,
  SETTINGS_TITLE,
  loadSettingsPage,
  parseSessionsError,
  settingsBreadcrumb,
} from "./settings-page";

const USER: CurrentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ada@example.com",
  displayName: "Ada",
};

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

describe("loadSettingsPage", () => {
  test("asks requireUser for /account/settings and drops the user id", async () => {
    const nextPaths: string[] = [];
    const requireUser = async (nextPath: string): Promise<CurrentUser> => {
      nextPaths.push(nextPath);
      return USER;
    };
    const data = await loadSettingsPage({}, { requireUser });
    expect(nextPaths).toEqual([SETTINGS_PATH]);
    expect(Object.keys(data.user).sort()).toEqual(["displayName", "email"]);
    expect(data.user).toEqual({ email: USER.email, displayName: USER.displayName });
    expect(JSON.stringify(data)).not.toContain(USER.id);
    expect(data.sessionsError).toBe(false);
  });

  test("guest: the requireUser redirect propagates and no data is built", async () => {
    const requireUser = mock(async (): Promise<CurrentUser> => {
      throw new RedirectSentinel("/signin?next=%2Faccount%2Fsettings");
    });
    let caught: unknown = null;
    try {
      await loadSettingsPage({ sessions: "error" }, { requireUser });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RedirectSentinel);
    expect((caught as RedirectSentinel).url).toBe("/signin?next=%2Faccount%2Fsettings");
  });

  test("sessions=error flag is read from search params", async () => {
    const data = await loadSettingsPage({ sessions: "error" }, { requireUser: async () => USER });
    expect(data.sessionsError).toBe(true);
  });
});

describe("parseSessionsError", () => {
  test.each([
    [{}, false],
    [{ sessions: "error" }, true],
    [{ sessions: ["error", "x"] }, true],
    [{ sessions: ["x", "error"] }, false],
    [{ sessions: "ERROR" }, false],
    [{ sessions: "" }, false],
    [{ sessions: undefined }, false],
  ] as const)("%j -> %p", (params, expected) => {
    expect(parseSessionsError(params as Record<string, string | string[] | undefined>)).toBe(expected);
  });
});

describe("constants", () => {
  test("breadcrumb is Home > Your Account > Login & security with allowed hrefs", () => {
    const items = settingsBreadcrumb();
    expect(items.map((i) => i.label)).toEqual(["Home", "Your Account", SETTINGS_TITLE]);
    expect(items[2]?.href).toBeUndefined();
    for (const item of items) if (item.href !== undefined) expect(isAllowedInternalHref(item.href)).toBe(true);
    expect(settingsBreadcrumb()).not.toBe(items);
  });

  test("title matches the AccountHub tile; error href is an allowed internal href", () => {
    expect(SETTINGS_TITLE).toBe("Login & security");
    expect(SESSIONS_ERROR_HREF).toBe("/account/settings?sessions=error");
    expect(isAllowedInternalHref(SESSIONS_ERROR_HREF)).toBe(true);
  });

  test("section ids are unique", () => {
    const ids = Object.values(SETTINGS_SECTION_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
