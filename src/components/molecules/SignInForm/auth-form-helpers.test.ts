import { describe, expect, test } from "bun:test";
import { AUTH_MESSAGES, tooManyAttemptsMessage } from "@/app/actions/auth-core";
import { isAllowedInternalHref } from "@/content/routes";
import { SAFE_NEXT_MAX_LENGTH as SERVER_SAFE_NEXT_MAX, safeNext } from "@/server/session/safe-next";
import {
  AUTH_FORM_MESSAGES,
  SAFE_NEXT_MAX_LENGTH,
  authPageHref,
  failureKind,
  fieldErrorOf,
  fieldSummaryItems,
  formLevelText,
  retryAfterOf,
  safeInternalHref,
  toSafeNext,
  tooManyAttemptsText,
  type AuthFailure,
} from "./auth-form-helpers";
import { HOSTILE_NEXT, authFailure } from "./auth-test-helpers";

function asFailure(state: ReturnType<typeof authFailure>): AuthFailure {
  if (state === null || state.ok) throw new Error("expected failure");
  return state;
}

const SAFE_NEXT = ["/orders", "/account/settings?x=1", "/products/oak-desk#reviews", "/", "/search?q=desk%20lamp", "/a/b/c-d_e.f~g"];

const NEXT_FIXTURES: unknown[] = [
  ...HOSTILE_NEXT,
  ...SAFE_NEXT,
  undefined,
  null,
  42,
  {},
  ["/orders"],
  "/%",
  "/%zz",
  "/%2f%2fevil",
  "/orders%5C",
  "/%00",
  "/\u0000",
  "/café",
  "/a b",
  "/a:b",
  "//",
  "/\\",
  "/".padEnd(512, "a"),
  "/".padEnd(513, "a"),
  "orders",
  "./orders",
  "data:text/html,x",
  "/%252F%252Fevil",
  "/%2Fevil",
];

describe("toSafeNext mirrors the server safeNext rule", () => {
  test("max length constant matches", () => {
    expect(SAFE_NEXT_MAX_LENGTH).toBe(SERVER_SAFE_NEXT_MAX);
  });

  test.each(NEXT_FIXTURES.map((v) => [JSON.stringify(v) ?? String(v), v] as const))("agrees on %s", (_label, raw) => {
    const server = safeNext(raw, "__FALLBACK__");
    const client = toSafeNext(raw);
    expect(client).toBe(server === "__FALLBACK__" ? null : server);
  });

  test("every brief hostile fixture is rejected, safe paths are kept", () => {
    for (const raw of HOSTILE_NEXT) expect(toSafeNext(raw)).toBeNull();
    for (const raw of SAFE_NEXT) expect(toSafeNext(raw)).toBe(raw);
  });
});

describe("hrefs", () => {
  test("authPageHref carries next only when safe, always allow-listed", () => {
    expect(authPageHref("/signup", "/orders")).toBe("/signup?next=%2Forders");
    expect(authPageHref("/signin", "/account/settings?x=1")).toBe("/signin?next=%2Faccount%2Fsettings%3Fx%3D1");
    expect(authPageHref("/signup", null)).toBe("/signup");
    expect(authPageHref("/signup", undefined)).toBe("/signup");
    for (const raw of HOSTILE_NEXT) {
      const href = authPageHref("/signin", raw);
      expect(href).toBe("/signin");
      expect(isAllowedInternalHref(href)).toBe(true);
    }
  });

  test("safeInternalHref falls back for off-site or unknown routes", () => {
    expect(safeInternalHref("/contact", "/x")).toBe("/contact");
    expect(safeInternalHref("/help?topic=a", "/x")).toBe("/help?topic=a");
    for (const bad of ["//evil.com", "https://evil.com", "javascript:alert(1)", "/not-a-route", "", null, undefined]) {
      expect(safeInternalHref(bad, "/contact")).toBe("/contact");
    }
  });
});

describe("messages mirror the action constants", () => {
  test("AUTH_FORM_MESSAGES equals AUTH_MESSAGES", () => {
    expect(AUTH_FORM_MESSAGES).toEqual(AUTH_MESSAGES);
  });

  test("tooManyAttemptsText equals tooManyAttemptsMessage for every input", () => {
    for (const s of [1, 59, 60, 61, 119, 120, 600, 899, 900, 3600, 0.5]) {
      expect(tooManyAttemptsText(s)).toBe(tooManyAttemptsMessage(s));
    }
    expect(tooManyAttemptsText(undefined)).toBe(tooManyAttemptsMessage(undefined));
    expect(tooManyAttemptsText(900)).toBe("Too many attempts. Try again in 15 minutes.");
    expect(tooManyAttemptsText(60)).toBe("Too many attempts. Try again in 1 minute.");
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "900", null]) {
      expect(tooManyAttemptsText(bad)).toBe(AUTH_FORM_MESSAGES.tooManyAttemptsFallback);
    }
  });
});

describe("failure classification", () => {
  test("R-10: TOO_MANY_ATTEMPTS, RATE_LIMITED and ACCOUNT_LOCKED share one kind and one text", () => {
    const a = asFailure(authFailure("TOO_MANY_ATTEMPTS", { retryAfterSeconds: 900 }));
    const locked = asFailure(authFailure("INTERNAL_ERROR", { errorCode: "ACCOUNT_LOCKED", retryAfterSeconds: 900 }));
    const limited = asFailure(authFailure("INTERNAL_ERROR", { errorCode: "RATE_LIMITED", retryAfterSeconds: 900 }));
    for (const f of [a, locked, limited]) {
      expect(failureKind(f)).toBe("too_many");
      expect(formLevelText(f)).toBe("Too many attempts. Try again in 15 minutes.");
    }
  });

  test("retryAfterOf falls back to error.details", () => {
    const f = asFailure(authFailure("TOO_MANY_ATTEMPTS", { retryAfterSeconds: 120 }));
    const detailsOnly: AuthFailure = { ...f, retryAfterSeconds: undefined };
    expect(retryAfterOf(detailsOnly)).toBe(120);
    expect(formLevelText(detailsOnly)).toBe("Too many attempts. Try again in 2 minutes.");
  });

  test("texts come from constants, never from the server message", () => {
    const evil = "<b>evil</b>";
    expect(formLevelText(asFailure(authFailure("INVALID_CREDENTIALS", { message: evil })))).toBe(AUTH_MESSAGES.invalidCredentials);
    expect(formLevelText(asFailure(authFailure("EMAIL_TAKEN", { message: evil })))).toBe(AUTH_MESSAGES.emailTaken);
    expect(formLevelText(asFailure(authFailure("INTERNAL_ERROR", { message: evil })))).toBe(AUTH_MESSAGES.internal);
    expect(formLevelText(asFailure(authFailure("UNAUTHENTICATED", { message: evil })))).toBe(AUTH_MESSAGES.internal);
    expect(formLevelText(asFailure(authFailure("VALIDATION_FAILED", { message: evil })))).toBe(AUTH_MESSAGES.invalid);
  });

  test("fieldSummaryItems keeps form order and skips blanks; fieldErrorOf ignores blanks", () => {
    const f = asFailure(
      authFailure("VALIDATION_FAILED", { fieldErrors: { password: "Too short", email: "  ", displayName: "Required" } }),
    );
    const items = fieldSummaryItems(f, [
      { field: "displayName", id: "d", label: "Display name" },
      { field: "email", id: "e", label: "Email" },
      { field: "password", id: "p", label: "Password" },
    ]);
    expect(items).toEqual([
      { id: "d", label: "Display name", message: "Required" },
      { id: "p", label: "Password", message: "Too short" },
    ]);
    expect(fieldErrorOf(f, "email")).toBeUndefined();
    expect(fieldErrorOf(f, "password")).toBe("Too short");
    expect(fieldErrorOf(null, "password")).toBeUndefined();
  });
});
