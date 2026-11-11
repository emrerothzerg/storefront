import { describe, expect, mock, test } from "bun:test";

import type { CurrentUser } from "@/server/session/current-user";

import {
  SIGNED_IN_FALLBACK,
  SIGN_IN_DESCRIPTION,
  SIGN_UP_DESCRIPTION,
  loadAuthPage,
  sanitizeNextParam,
  signedInRedirectTarget,
  type AuthPageDeps,
} from "./auth-pages";

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

const USER: CurrentUser = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.test", displayName: "A" };

function deps(user: CurrentUser | null | Error): AuthPageDeps & { redirect: ReturnType<typeof mock> } {
  return {
    readCurrentUser: async () => {
      if (user instanceof Error) throw user;
      return user;
    },
    redirect: mock((url: string): never => {
      throw new RedirectSentinel(url);
    }),
  };
}

const DROPPED: readonly unknown[] = [
  "//evil.com",
  "https://evil.com",
  "http://evil.com/orders",
  "javascript:alert(1)",
  "/\\evil",
  "/\\evil.com",
  "%2F%2Fevil",
  "/%2F%2Fevil.com",
  "/%2Fevil.com",
  "/%5Cevil",
  "",
  " /orders",
  "/orders\n",
  "orders",
  "/sign in",
  "/%E0%A4%A",
  `/${"a".repeat(600)}`,
  "/signin",
  "/signup",
  "/signin?next=%2Forders",
  "/signup#x",
  ["/orders", "/cart"],
  ["/orders"],
  undefined,
];

const KEPT: readonly string[] = ["/orders", "/account", "/orders/abc-123", "/search?q=desk&page=2", "/lists#top", "/signin-help", "/"];

describe("sanitizeNextParam (criterion 3)", () => {
  test.each(DROPPED.map((v) => [v]))("drops %p", (raw) => {
    const sp: Record<string, string | string[] | undefined> = {};
    if (raw !== undefined) sp.next = raw as string | string[];
    expect(sanitizeNextParam(sp)).toBeNull();
  });

  test.each(KEPT.map((v) => [v]))("keeps %p", (raw) => {
    expect(sanitizeNextParam({ next: raw })).toBe(raw);
  });

  test("other params are ignored", () => {
    expect(sanitizeNextParam({ redirect: "/orders", returnTo: "/orders" })).toBeNull();
  });
});

describe("signedInRedirectTarget", () => {
  test("sanitised next or /account", () => {
    expect(signedInRedirectTarget("/orders")).toBe("/orders");
    expect(signedInRedirectTarget(null)).toBe("/account");
    expect(SIGNED_IN_FALLBACK).toBe("/account");
  });
});

describe("loadAuthPage", () => {
  test("guest: returns the sanitised next, no redirect", async () => {
    const d = deps(null);
    expect(await loadAuthPage({ next: "/orders" }, d)).toEqual({ next: "/orders" });
    expect(await loadAuthPage({ next: "//evil.com" }, d)).toEqual({ next: null });
    expect(await loadAuthPage({}, d)).toEqual({ next: null });
    expect(d.redirect).not.toHaveBeenCalled();
  });

  test("signed in: redirects to safe next", async () => {
    const d = deps(USER);
    await expect(loadAuthPage({ next: "/orders" }, d)).rejects.toMatchObject({ url: "/orders" });
    expect(d.redirect).toHaveBeenCalledTimes(1);
  });

  test("signed in: unsafe, missing or array next redirects to /account", async () => {
    for (const sp of [{}, { next: "https://evil.com" }, { next: ["/orders"] }, { next: "/signin" }]) {
      const d = deps(USER);
      await expect(loadAuthPage(sp, d)).rejects.toMatchObject({ url: "/account" });
    }
  });

  test("errors from the user lookup propagate (readCurrentUser itself never throws app errors)", async () => {
    await expect(loadAuthPage({}, deps(new Error("boom")))).rejects.toThrow("boom");
  });
});

describe("copy", () => {
  test("descriptions fit the metadata limits", () => {
    for (const d of [SIGN_IN_DESCRIPTION, SIGN_UP_DESCRIPTION]) {
      expect(d.length).toBeGreaterThanOrEqual(70);
      expect(d.length).toBeLessThanOrEqual(160);
    }
  });
});
